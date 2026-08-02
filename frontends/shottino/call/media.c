/* media.c — see media.h for the ffmpeg-does-codecs split. */
#include "media.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#define MEDIA_MAX_ARGS 64

const char *media_video_codec_name(enum media_video_codec codec) {
    return codec == MEDIA_VIDEO_H264 ? "H264" : "VP8";
}

bool media_video_codec_parse(const char *word, enum media_video_codec *out) {
    if (!word || !out) return false;
    if (strcmp(word, "vp8") == 0 || strcmp(word, "VP8") == 0) {
        *out = MEDIA_VIDEO_VP8;
        return true;
    }
    if (strcmp(word, "h264") == 0 || strcmp(word, "H264") == 0 || strcmp(word, "H.264") == 0) {
        *out = MEDIA_VIDEO_H264;
        return true;
    }
    return false;
}

int media_bind_loopback(int *port_out) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0; /* the kernel picks; asking for a fixed one is how
                        * two calls on one machine collide */
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(fd);
        return -1;
    }
    socklen_t len = sizeof(addr);
    if (getsockname(fd, (struct sockaddr *)&addr, &len) != 0) {
        close(fd);
        return -1;
    }
    if (port_out) *port_out = ntohs(addr.sin_port);
    return fd;
}

/* Split shottino's `format:input` spelling, which is what /voicemsg and
 * /video already use, so one device setting serves every feature. A
 * source without a colon is taken as an input with ffmpeg's default
 * demuxer, which is what a bare file path wants. */
static void split_source(const char *source, const char **fmt, const char **input,
                         char *scratch, size_t scratch_sz) {
    snprintf(scratch, scratch_sz, "%s", source ? source : "");
    char *colon = strchr(scratch, ':');
    if (colon) {
        *colon = 0;
        *fmt = scratch;
        *input = colon + 1;
    } else {
        *fmt = NULL;
        *input = scratch;
    }
}

/* fork+exec ffmpeg with stdout wired to `stdout_fd` (or /dev/null) and
 * stderr discarded.
 *
 * ffmpeg's own diagnostics are dropped rather than merged into stderr:
 * stderr here is the JSON event stream shottino parses, and ffmpeg's
 * progress lines would be garbage in it. A failure shows as the process
 * dying, which the caller sees. */
static pid_t spawn_ffmpeg(char *const argv[], int stdout_fd) {
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        int devnull = open("/dev/null", O_RDWR);
        if (devnull >= 0) {
            dup2(devnull, STDIN_FILENO);
            dup2(stdout_fd >= 0 ? stdout_fd : devnull, STDOUT_FILENO);
            dup2(devnull, STDERR_FILENO);
            if (devnull > STDERR_FILENO) close(devnull);
        }
        execvp("ffmpeg", argv);
        _exit(127);
    }
    return pid;
}

bool media_start_send(struct media_leg *leg, const struct media_config *cfg, bool video) {
    memset(leg, 0, sizeof(*leg));
    leg->pid = -1;
    leg->fd = -1;
    leg->video = video;
    if (!cfg) return false;

    int port = 0;
    leg->fd = media_bind_loopback(&port);
    if (leg->fd < 0) return false;

    char scratch[256];
    const char *fmt = NULL, *input = NULL;
    split_source(video ? cfg->video_source : cfg->audio_source, &fmt, &input, scratch,
                 sizeof(scratch));

    char dest[64], pt[16], ssrc[16], rate[16], bitrate[16], vfilter[160], gop[16];
    snprintf(dest, sizeof(dest), "rtp://127.0.0.1:%d", port);
    snprintf(pt, sizeof(pt), "%d", video ? cfg->video_payload_type : cfg->audio_payload_type);
    snprintf(ssrc, sizeof(ssrc), "%u", (unsigned)(video ? cfg->video_ssrc : cfg->audio_ssrc));
    /* CAPTURE geometry, never the render box: see media.h. */
    int cw = cfg->capture_w > 0 ? cfg->capture_w : 640;
    int ch = cfg->capture_h > 0 ? cfg->capture_h : 480;
    int cfps = cfg->capture_fps > 0 ? cfg->capture_fps : 20;
    snprintf(rate, sizeof(rate), "%d", cfps);
    snprintf(vfilter, sizeof(vfilter), "fps=%d,scale=%d:%d:force_original_aspect_ratio=decrease,"
                                       "pad=%d:%d:(ow-iw)/2:(oh-ih)/2",
             cfps, cw, ch, cw, ch);
    /* Audio is Opus at conversational quality; video is whatever the
     * sender was told to spend, because the RECEIVER decides what it
     * can use and a browser can use a great deal more than a terminal. */
    if (video) snprintf(bitrate, sizeof(bitrate), "%dk", cfg->video_kbps > 0 ? cfg->video_kbps : 800);
    else snprintf(bitrate, sizeof(bitrate), "24k");
    /* A keyframe every two seconds, for BOTH codecs.
     *
     * This is what a late joiner costs: a decoder that attaches to a
     * stream mid-flight shows nothing until the next keyframe, and the
     * defaults are hopeless for a call — x264's keyint is 250 frames,
     * twelve seconds at this rate, and there is no PLI path here to ask
     * for one. In a group call somebody is ALWAYS joining late, and the
     * video mix restarts on a re-tile besides. Two seconds of black is
     * a hiccup; twelve is a bug report. */
    snprintf(gop, sizeof(gop), "%d", cfps * 2);

    char *argv[MEDIA_MAX_ARGS];
    size_t n = 0;
    argv[n++] = (char *)"ffmpeg";
    argv[n++] = (char *)"-nostdin";
    argv[n++] = (char *)"-loglevel";
    argv[n++] = (char *)"error";
    if (fmt && fmt[0]) {
        argv[n++] = (char *)"-f";
        argv[n++] = (char *)fmt;
    }
    argv[n++] = (char *)"-i";
    argv[n++] = (char *)input;
    if (video) {
        /* Rate and size are enforced in the FILTER graph, never as input
         * options. `-framerate`/`-video_size` are demuxer-specific: v4l2
         * takes them, lavfi refuses them outright ("Option framerate not
         * found"), and the capture then dies with its stderr discarded —
         * a silent leg producing no packets. A filter works for every
         * input, and it also guarantees the encoder gets exactly the
         * geometry that was promised whatever the device felt like
         * giving. */
        argv[n++] = (char *)"-vf";
        argv[n++] = vfilter;
        argv[n++] = (char *)"-an";
        argv[n++] = (char *)"-c:v";
        if (cfg->video_codec == MEDIA_VIDEO_H264) {
            argv[n++] = (char *)"libx264";
            argv[n++] = (char *)"-b:v";
            argv[n++] = bitrate;
            /* Real time beats quality: a frame that arrives late is
             * worse than a frame that arrived rough. */
            argv[n++] = (char *)"-preset";
            argv[n++] = (char *)"ultrafast";
            argv[n++] = (char *)"-tune";
            argv[n++] = (char *)"zerolatency";
            /* Constrained Baseline, which is what libdatachannel offers
             * (profile-level-id=42e01f) and what every browser and phone
             * decodes. A stream whose profile is above what the offer
             * promised is one the far end is entitled to drop. */
            argv[n++] = (char *)"-profile:v";
            argv[n++] = (char *)"baseline";
            argv[n++] = (char *)"-pix_fmt";
            argv[n++] = (char *)"yuv420p";
            /* SPS/PPS in front of every keyframe, not once at the start.
             * There is no out-of-band sprop-parameter-sets on this path,
             * so a decoder that attached late has no other way to learn
             * the parameter sets and stays blank forever. */
            argv[n++] = (char *)"-bsf:v";
            argv[n++] = (char *)"dump_extra";
        } else {
            argv[n++] = (char *)"libvpx";
            argv[n++] = (char *)"-b:v";
            argv[n++] = bitrate;
            argv[n++] = (char *)"-deadline";
            argv[n++] = (char *)"realtime";
            argv[n++] = (char *)"-cpu-used";
            argv[n++] = (char *)"8";
        }
        argv[n++] = (char *)"-g";
        argv[n++] = gop;
    } else {
        argv[n++] = (char *)"-vn";
        argv[n++] = (char *)"-c:a";
        argv[n++] = (char *)"libopus";
        argv[n++] = (char *)"-b:a";
        argv[n++] = bitrate;
        argv[n++] = (char *)"-ar";
        argv[n++] = (char *)"48000";
        argv[n++] = (char *)"-ac";
        argv[n++] = (char *)"2";
    }
    argv[n++] = (char *)"-payload_type";
    argv[n++] = pt;
    argv[n++] = (char *)"-ssrc";
    argv[n++] = ssrc;
    argv[n++] = (char *)"-f";
    argv[n++] = (char *)"rtp";
    argv[n++] = dest;
    argv[n] = NULL;

    leg->pid = spawn_ffmpeg(argv, -1);
    if (leg->pid < 0) {
        close(leg->fd);
        leg->fd = -1;
        return false;
    }
    return true;
}

bool media_recv_sdp(const struct media_config *cfg, bool video, int port, char *out,
                    size_t out_sz) {
    if (!cfg || !out || out_sz == 0 || port <= 0) return false;
    int pt = video ? cfg->video_payload_type : cfg->audio_payload_type;
    /* c= is the loopback the helper writes to; the rtpmap must match
     * what the offer negotiated or the decoder sits silent with no
     * error, which is the least debuggable failure this design has. */
    int w;
    if (!video) {
        w = snprintf(out, out_sz,
                     "v=0\r\n"
                     "o=- 0 0 IN IP4 127.0.0.1\r\n"
                     "s=shottino\r\n"
                     "c=IN IP4 127.0.0.1\r\n"
                     "t=0 0\r\n"
                     "m=audio %d RTP/AVP %d\r\n"
                     "a=rtpmap:%d opus/48000/2\r\n",
                     port, pt, pt);
        return w > 0 && (size_t)w < out_sz;
    }
    /* H.264 additionally needs its packetization mode spelled out: a
     * depacketiser told nothing assumes single-NAL, and a real sender
     * fragments (FU-A) the moment a frame exceeds the MTU — which is
     * every keyframe. The result is a decoder that reports nothing and
     * shows nothing. VP8 carries no such ambiguity, so it gets no fmtp
     * rather than an empty one. */
    char fmtp[64] = { 0 };
    if (cfg->video_codec == MEDIA_VIDEO_H264)
        snprintf(fmtp, sizeof(fmtp), "a=fmtp:%d packetization-mode=1\r\n", pt);
    w = snprintf(out, out_sz,
                 "v=0\r\n"
                 "o=- 0 0 IN IP4 127.0.0.1\r\n"
                 "s=shottino\r\n"
                 "c=IN IP4 127.0.0.1\r\n"
                 "t=0 0\r\n"
                 "m=video %d RTP/AVP %d\r\n"
                 "a=rtpmap:%d %s/90000\r\n"
                 "%s",
                 port, pt, pt, media_video_codec_name(cfg->video_codec), fmtp);
    return w > 0 && (size_t)w < out_sz;
}

bool media_start_recv(struct media_leg *leg, const struct media_config *cfg, bool video,
                      int stdout_fd) {
    memset(leg, 0, sizeof(*leg));
    leg->pid = -1;
    leg->fd = -1;
    leg->video = video;
    if (!cfg) return false;

    /* Bind the port ffmpeg will listen on, learn its number, then close
     * it: ffmpeg opens it itself, and two holders of one UDP port is a
     * race over who receives. The window between is on loopback and
     * ends immediately. */
    int port = 0;
    int probe = media_bind_loopback(&port);
    if (probe < 0) return false;
    close(probe);

    char sdp[512];
    if (!media_recv_sdp(cfg, video, port, sdp, sizeof(sdp))) return false;

    /* ffmpeg reads the description from a file; a template in TMPDIR so
     * two calls cannot collide, unlinked as soon as ffmpeg has it. */
    char path[] = "/tmp/shottino-call-XXXXXX";
    int sdp_fd = mkstemp(path);
    if (sdp_fd < 0) return false;
    size_t sdp_len = strlen(sdp);
    bool wrote = write(sdp_fd, sdp, sdp_len) == (ssize_t)sdp_len;
    close(sdp_fd);
    if (!wrote) {
        unlink(path);
        return false;
    }

    /* fps= is not decoration: without a rate bound ffmpeg emits frames
     * as fast as the RTP timebase lets it — a measured 14 800 frames in
     * eight seconds, i.e. ~1850 fps of rgb24 down a pipe shottino reads
     * at ten. The same rate the sender was told to use. */
    char scale[192];
    snprintf(scale, sizeof(scale), "fps=%d,scale=%d:%d:force_original_aspect_ratio=decrease,"
                                   "pad=%d:%d:(ow-iw)/2:(oh-ih)/2,format=rgb24",
             cfg->fps > 0 ? cfg->fps : 10,
             cfg->frame_w > 0 ? cfg->frame_w : 320, cfg->frame_h > 0 ? cfg->frame_h : 240,
             cfg->frame_w > 0 ? cfg->frame_w : 320, cfg->frame_h > 0 ? cfg->frame_h : 240);

    char *argv[MEDIA_MAX_ARGS];
    size_t n = 0;
    argv[n++] = (char *)"ffmpeg";
    /* -nostdin, or the leg dies the instant it starts.
     *
     * ffmpeg reads stdin for interactive keys; this one is handed
     * /dev/null, which is EOF, and it quits before a single packet
     * arrives — reporting "Output file does not contain any stream",
     * which reads like a filter or codec problem and is neither. The
     * capture leg has the same mouth to stop. */
    argv[n++] = (char *)"-nostdin";
    argv[n++] = (char *)"-loglevel";
    argv[n++] = (char *)"error";
    /* The same #451 posture the inline decoder takes: this input is
     * driven by a stranger's media, so ffmpeg gets only the protocols
     * this path needs and none of the demuxers a hostile stream could
     * otherwise reach. */
    argv[n++] = (char *)"-protocol_whitelist";
    argv[n++] = (char *)"file,udp,rtp";
    /* NO -fflags nobuffer / -flags low_delay here, deliberately.
     *
     * They looked like the obvious choice for a call and they cost the
     * whole picture: they make the demuxer discard rather than reorder,
     * so any jitter loses packets, the keyframe never assembles, and the
     * decoder reports "Invalid data found" on EVERY packet and gives up
     * at a 100% error rate. A stream sent straight from ffmpeg is paced
     * tightly enough to survive it; one that has crossed a network and a
     * relay is not — measured both ways, 0 frames with the flags and 118
     * without, same six seconds and the same packets.
     *
     * The tens of milliseconds they would save are not worth a blank
     * window. */
    argv[n++] = (char *)"-i";
    argv[n++] = path;
    if (video) {
        /* Straight to the helper's own stdout, which IS the frame
         * stream: no copy, no framing layer to desynchronise. Same
         * scale-and-pad convention as shottino's inline decoder, so a
         * call frame is byte-identical in shape to a clip frame and
         * everything downstream indexes it the same way. */
        argv[n++] = (char *)"-an";
        argv[n++] = (char *)"-vf";
        argv[n++] = scale;
        argv[n++] = (char *)"-f";
        argv[n++] = (char *)"rawvideo";
        argv[n++] = (char *)"-pix_fmt";
        argv[n++] = (char *)"rgb24";
        argv[n++] = (char *)"pipe:1";
    } else {
        /* The SINK is its own setting, never inferred from how the
         * capture source is spelled. Deriving one from the other turns
         * `--audio-source lavfi:sine=…` into `-f lavfi` as an OUTPUT
         * format, which is not a thing — and on a real machine it would
         * quietly assume that whoever captures with pulse plays back
         * with it. */
        char sink[256];
        const char *fmt = NULL, *dev = NULL;
        split_source(cfg->audio_sink && cfg->audio_sink[0] ? cfg->audio_sink : "alsa:default",
                     &fmt, &dev, sink, sizeof(sink));
        argv[n++] = (char *)"-vn";
        argv[n++] = (char *)"-f";
        argv[n++] = (char *)(fmt && fmt[0] ? fmt : "alsa");
        argv[n++] = (char *)(dev && dev[0] ? dev : "default");
    }
    argv[n] = NULL;

    leg->pid = spawn_ffmpeg(argv, video ? stdout_fd : -1);
    if (leg->pid < 0) {
        unlink(path);
        return false;
    }
    /* Removed at stop, NOT here: the child may not have exec'd yet, and
     * unlinking under it leaves the decoder reading nothing and emitting
     * no frames — silently, because its stderr is discarded. */
    snprintf(leg->sdp_path, sizeof(leg->sdp_path), "%s", path);

    leg->fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (leg->fd < 0) {
        media_stop(leg);
        return false;
    }
    leg->peer_port = port;
    return true;
}

bool media_start_mix(struct media_leg *legs, int n, const struct media_config *cfg) {
    if (!legs || n <= 0 || !cfg) return false;
    if (n > 16) n = 16; /* the argv below is sized for it */

    char *argv[MEDIA_MAX_ARGS + 16 * 2];
    size_t a = 0;
    argv[a++] = (char *)"ffmpeg";
    argv[a++] = (char *)"-nostdin";
    argv[a++] = (char *)"-loglevel";
    argv[a++] = (char *)"error";

    char filter[64];
    /* normalize=0: with normalising, one person speaking is quieter the
     * more silent people are in the room, which is exactly backwards. */
    snprintf(filter, sizeof(filter), "amix=inputs=%d:normalize=0", n);

    for (int i = 0; i < n; i++) {
        memset(&legs[i], 0, sizeof(legs[i]));
        legs[i].pid = -1;
        legs[i].fd = -1;
        int port = 0;
        int probe = media_bind_loopback(&port);
        if (probe < 0) goto fail;
        close(probe); /* ffmpeg opens it itself */
        char sdp[512];
        if (!media_recv_sdp(cfg, false, port, sdp, sizeof(sdp))) goto fail;
        char path[] = "/tmp/shottino-mix-XXXXXX";
        int fd = mkstemp(path);
        if (fd < 0) goto fail;
        size_t len = strlen(sdp);
        bool wrote = write(fd, sdp, len) == (ssize_t)len;
        close(fd);
        if (!wrote) { unlink(path); goto fail; }
        snprintf(legs[i].sdp_path, sizeof(legs[i].sdp_path), "%s", path);
        legs[i].peer_port = port;
        /* The same #451 posture as every other untrusted input. */
        argv[a++] = (char *)"-protocol_whitelist";
        argv[a++] = (char *)"file,udp,rtp";
        argv[a++] = (char *)"-i";
        argv[a++] = legs[i].sdp_path;
    }

    argv[a++] = (char *)"-filter_complex";
    argv[a++] = filter;
    argv[a++] = (char *)"-vn";
    char sink[256];
    const char *fmt = NULL, *dev = NULL;
    split_source(cfg->audio_sink && cfg->audio_sink[0] ? cfg->audio_sink : "alsa:default", &fmt,
                 &dev, sink, sizeof(sink));
    argv[a++] = (char *)"-f";
    argv[a++] = (char *)(fmt && fmt[0] ? fmt : "alsa");
    argv[a++] = (char *)(dev && dev[0] ? dev : "default");
    argv[a] = NULL;

    legs[0].pid = spawn_ffmpeg(argv, -1);
    if (legs[0].pid < 0) goto fail;
    for (int i = 0; i < n; i++) {
        legs[i].fd = socket(AF_INET, SOCK_DGRAM, 0);
        if (legs[i].fd < 0) { media_stop(&legs[0]); goto fail; }
    }
    return true;

fail:
    for (int i = 0; i < n; i++) media_stop(&legs[i]);
    return false;
}

void media_feed(const struct media_leg *leg, const void *rtp, size_t len) {
    if (!leg || leg->fd < 0 || leg->peer_port <= 0 || !rtp || len == 0) return;
    struct sockaddr_in to;
    memset(&to, 0, sizeof(to));
    to.sin_family = AF_INET;
    to.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    to.sin_port = htons((uint16_t)leg->peer_port);
    /* Best effort by design: this is RTP. A datagram the decoder was not
     * ready for is a lost packet, which is a thing RTP already expects
     * and a thing blocking here would turn into a stalled call. */
    (void)sendto(leg->fd, rtp, len, MSG_DONTWAIT, (struct sockaddr *)&to, sizeof(to));
}

void media_stop(struct media_leg *leg) {
    if (!leg) return;
    if (leg->pid > 0) {
        kill(leg->pid, SIGTERM);
        /* Reaped here rather than left to init: a call that is restarted
         * a few times would otherwise leave a zombie per leg. */
        while (waitpid(leg->pid, NULL, 0) < 0 && errno == EINTR) {}
        leg->pid = -1;
    }
    if (leg->fd >= 0) {
        close(leg->fd);
        leg->fd = -1;
    }
    if (leg->sdp_path[0]) {
        unlink(leg->sdp_path);
        leg->sdp_path[0] = 0;
    }
    leg->peer_port = 0;
}
