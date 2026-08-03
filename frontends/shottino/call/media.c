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

/* Round down to even. The composited frame is drawn as half blocks —
 * two pixel rows per cell — so an odd height loses its bottom row, and
 * an odd width upsets every scaler that ever meets a chroma plane. */
static int even_down(int v) { return v & ~1; }

/* Smallest k with k*k >= n, for n up to the peer cap. */
static int grid_cols_for(int n) {
    int k = 1;
    while (k * k < n) k++;
    return k;
}

int media_grid_layout(const int *slots, int n, int frame_w, int frame_h, struct media_tile *out,
                      int max) {
    if (n <= 0 || max <= 0 || !out || !slots || frame_w <= 0 || frame_h <= 0) return 0;
    if (n > max) n = max;

    /* Wider than tall: one row of two beats a column of two, because a
     * terminal cell is about twice as tall as it is wide and the
     * pictures are landscape to begin with. */
    int cols = grid_cols_for(n);
    int rows = (n + cols - 1) / cols;
    int cw = even_down(frame_w / cols), ch = even_down(frame_h / rows);
    /* Below this a cell carries nothing a viewer could read — this
     * becomes ASCII art of a face — so rather than lay out confetti,
     * drop back to a coarser grid and report fewer. */
    while ((cw < 16 || ch < 12) && n > 1) {
        n--;
        cols = grid_cols_for(n);
        rows = (n + cols - 1) / cols;
        cw = even_down(frame_w / cols);
        ch = even_down(frame_h / rows);
    }
    if (cw <= 0 || ch <= 0) return 0;

    for (int i = 0; i < n; i++) {
        out[i].slot = slots[i];
        out[i].w = cw;
        out[i].h = ch;
        out[i].x = (i % cols) * cw;
        out[i].y = (i / cols) * ch;
    }
    return n;
}

bool media_mix_filter(const struct media_tile *tiles, int n, int fps, int frame_w, int frame_h,
                      char *out, size_t out_sz) {
    if (!tiles || n <= 0 || !out || out_sz == 0 || frame_w <= 0 || frame_h <= 0) return false;
    if (fps < 1) fps = 10;
    size_t at = 0;
    /* Every input scaled and padded into its cell. setsar=1 because an
     * overlay refuses to compose sources whose sample aspect ratios
     * disagree, and a camera that reports a non-square one otherwise
     * kills the whole graph rather than just looking wrong.
     *
     * The FIRST one is padded twice: once into its cell, then out to
     * the whole frame at that cell's position, so it becomes the canvas
     * the rest are overlaid onto. Without the second pad the canvas is
     * one cell and every other peer is clipped off the edge of it — an
     * output silently a quarter of the size it should be. Doing it this
     * way rather than with a synthetic colour source keeps the input
     * count equal to the peer count, which is what the tile indices and
     * the -i order both assume. */
    for (int i = 0; i < n; i++) {
        int w = tiles[i].w > 0 ? tiles[i].w : 2, h = tiles[i].h > 0 ? tiles[i].h : 2;
        char canvas[64] = "";
        if (i == 0)
            snprintf(canvas, sizeof(canvas), "pad=%d:%d:%d:%d,", frame_w, frame_h, tiles[0].x,
                     tiles[0].y);
        int k = snprintf(out + at, out_sz - at,
                         "[%d:v]fps=%d,scale=%d:%d:force_original_aspect_ratio=decrease,"
                         "pad=%d:%d:(ow-iw)/2:(oh-ih)/2,%ssetsar=1[t%d];",
                         i, fps, w, h, w, h, canvas, i);
        if (k < 0 || (size_t)k >= out_sz - at) return false;
        at += (size_t)k;
    }
    if (n == 1) {
        /* One peer: the scaled input IS the output. A one-input overlay
         * chain would be a no-op stage that still has to be parsed. */
        int k = snprintf(out + at, out_sz - at, "[t0]null[out]");
        return k > 0 && (size_t)k < out_sz - at;
    }
    /* Thumbnails overlaid on the focused peer, in order.
     *
     * eof_action=pass so a peer who hangs up leaves the call running
     * instead of ending everybody's picture, and repeatlast so their
     * last frame stays put rather than the tile going black-then-absent
     * while the supervisor notices and re-tiles. */
    for (int i = 1; i < n; i++) {
        char base[16], sink[16];
        /* The first overlay reads the focused peer; every later one
         * reads what the previous overlay produced. The last writes the
         * name the caller maps, and the others write a link. */
        if (i == 1) snprintf(base, sizeof(base), "[t0]");
        else snprintf(base, sizeof(base), "[m%d]", i - 1);
        if (i == n - 1) snprintf(sink, sizeof(sink), "[out]");
        else snprintf(sink, sizeof(sink), "[m%d];", i);
        int k = snprintf(out + at, out_sz - at,
                         "%s[t%d]overlay=%d:%d:eof_action=pass:repeatlast=1%s", base, i,
                         tiles[i].x, tiles[i].y, sink);
        if (k < 0 || (size_t)k >= out_sz - at) return false;
        at += (size_t)k;
    }
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

/* Give a leg a loopback port and an SDP, without starting anything.
 * The port SURVIVES a re-tile: the RTP callback keeps writing to it
 * while the decoder behind it is being replaced, so a focus change
 * costs a moment of dropped packets rather than a renumbering the
 * callback cannot see. */
static bool leg_prepare_recv(struct media_leg *leg, const struct media_config *cfg, bool video) {
    if (leg->peer_port > 0 && leg->fd >= 0 && leg->sdp_path[0]) return true; /* already has one */
    leg->video = video;
    int port = 0;
    int probe = media_bind_loopback(&port);
    if (probe < 0) return false;
    close(probe); /* ffmpeg opens it itself */

    char sdp[512];
    if (!media_recv_sdp(cfg, video, port, sdp, sizeof(sdp))) return false;
    char path[] = "/tmp/shottino-mix-XXXXXX";
    int fd = mkstemp(path);
    if (fd < 0) return false;
    size_t len = strlen(sdp);
    bool wrote = write(fd, sdp, len) == (ssize_t)len;
    close(fd);
    if (!wrote) {
        unlink(path);
        return false;
    }
    snprintf(leg->sdp_path, sizeof(leg->sdp_path), "%s", path);
    leg->peer_port = port;
    if (leg->fd < 0) leg->fd = socket(AF_INET, SOCK_DGRAM, 0);
    return leg->fd >= 0;
}

void media_stop_video_mix(struct media_mix *mix) {
    if (!mix || mix->pid <= 0) return;
    kill(mix->pid, SIGTERM);
    while (waitpid(mix->pid, NULL, 0) < 0 && errno == EINTR) {}
    mix->pid = -1;
}

void media_free_video_mix(struct media_mix *mix) {
    if (!mix) return;
    media_stop_video_mix(mix);
    for (int i = 0; i < MEDIA_MAX_PEERS; i++) media_stop(&mix->legs[i]);
    mix->tile_count = 0;
}

bool media_start_video_mix(struct media_mix *mix, const struct media_config *cfg, int stdout_fd) {
    if (!mix || !cfg || mix->tile_count <= 0) return false;
    int n = mix->tile_count;
    if (n > MEDIA_MAX_PEERS) n = MEDIA_MAX_PEERS;

    media_stop_video_mix(mix); /* a re-tile replaces the decoder, not the ports */

    for (int i = 0; i < n; i++) {
        int slot = mix->tiles[i].slot;
        if (slot < 0 || slot >= MEDIA_MAX_PEERS) return false;
        if (!leg_prepare_recv(&mix->legs[slot], cfg, true)) return false;
    }

    /* Eight peers of scale-and-pad plus an overlay chain. Measured at
     * about 130 bytes per input, so this has room for twice the cap. */
    char filter[4096];
    if (!media_mix_filter(mix->tiles, n, cfg->fps, cfg->frame_w, cfg->frame_h, filter,
                          sizeof(filter)))
        return false;

    char *argv[MEDIA_MAX_ARGS + MEDIA_MAX_PEERS * 4];
    size_t a = 0;
    argv[a++] = (char *)"ffmpeg";
    argv[a++] = (char *)"-nostdin";
    argv[a++] = (char *)"-loglevel";
    argv[a++] = (char *)"error";
    /* INPUTS IN TILE ORDER, which is why the filter can name them by
     * index: input i is tiles[i], and tiles[0] is whoever is focused. */
    for (int i = 0; i < n; i++) {
        /* The same #451 posture as every other untrusted input. */
        argv[a++] = (char *)"-protocol_whitelist";
        argv[a++] = (char *)"file,udp,rtp";
        argv[a++] = (char *)"-i";
        argv[a++] = mix->legs[mix->tiles[i].slot].sdp_path;
    }
    argv[a++] = (char *)"-filter_complex";
    argv[a++] = filter;
    argv[a++] = (char *)"-map";
    argv[a++] = (char *)"[out]";
    argv[a++] = (char *)"-an";
    argv[a++] = (char *)"-f";
    argv[a++] = (char *)"rawvideo";
    argv[a++] = (char *)"-pix_fmt";
    argv[a++] = (char *)"rgb24";
    argv[a++] = (char *)"pipe:1";
    argv[a] = NULL;

    mix->pid = spawn_ffmpeg(argv, stdout_fd);
    return mix->pid > 0;
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
