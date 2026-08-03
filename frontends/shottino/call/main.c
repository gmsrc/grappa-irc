/* shottino-call — the media helper for terminal calls.
 *
 * A SEPARATE PROCESS, not a plugin. shottino already works this way four
 * times over (ffmpeg, whisper-cli, stdbuf, and the MCP shim where it
 * re-execs itself), and here the reasons are sharper still:
 *
 *   - no ABI to keep stable, and no C++ runtime inside shottino;
 *   - shottino's `make check` gate stays pure C — the media code never
 *     links into the sanitized test binaries;
 *   - WebRTC is precisely the code that will segfault. Out of process
 *     that drops the call; in process it takes the IRC session with it.
 *
 * ONE OR TWO SESSIONS, because SFUs come in two shapes:
 *
 *   --whip alone         one sendrecv session. What a single-endpoint
 *                        SFU (Galène, LiveKit) expects.
 *   --whip with --whep   publish sendonly to one endpoint, subscribe
 *                        recvonly from another. What MediaMTX expects:
 *                        its WHIP is publish-ONLY and its WHEP read-only,
 *                        so a lone sendrecv POST is accepted as a publish
 *                        and simply never sends anything back — a call
 *                        with no sound and no error.
 *   --whep alone         watch a room without publishing. No camera and
 *                        no microphone are opened: "it produced no
 *                        error" is not good enough for a device light.
 *
 * Output contract:
 *   stdout — the raw rgb24 frame stream. NOTHING else writes here.
 *   stderr — one JSON object per line: {"event":…}. With --verbose,
 *            human notes are interleaved as `#` comment lines, which a
 *            parser skips on the first character.
 */
#include "media.h"
#include "whip.h"

#include <errno.h>
#include <getopt.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <rtc/rtc.h>

/* The helper↔shottino contract version. shottino runs `shottino-call
 * --protocol` and refuses a number it does not know, so a helper left
 * behind by an older install fails LOUDLY instead of misbehaving. */
#define CALL_PROTOCOL 1

/* How many other people one call can carry. A mesh of subscribes is
 * cheap here because the render target is ASCII — a peer costs ~24 kbps
 * of Opus and ~150 kbps of tiny VP8 — but it is not free, and a cap is
 * how "the channel had forty people in it" fails as a clear message
 * rather than as a machine that stops responding.
 *
 * Taken from media.h rather than spelled again: the leg and tile arrays
 * there are sized by it, and two constants that must be equal are one
 * waiting to not be. */
#define CALL_MAX_PEERS MEDIA_MAX_PEERS

/* How often the video mix is re-examined, and how many quiet ticks it
 * takes to conclude a peer has stopped sending. See video_supervise(). */
#define CALL_TILE_TICK_SECS 1
#define CALL_TILE_MISSES 3

/* How many pictures the mix will composite at once. NOT a layout limit
 * — the layout would happily fit four — but a MEASURED one.
 *
 * ffmpeg opens live RTP inputs SEQUENTIALLY, and each open blocks long
 * enough that the sockets already opened overflow and have to resync.
 * The cost is therefore not linear in the number of pictures, it
 * roughly doubles per picture. Measured on an idle 8-core box, time
 * from spawning the mix to its first composited frame:
 *
 *     1 picture   0.3s      3 pictures   5.7s
 *     2 pictures  2.2s      4 pictures  12.4s      6+  never (>15s)
 *
 * Established as the cause rather than assumed: four inputs opened with
 * NO filter graph at all and only one of them mapped still took 14s, so
 * it is the opening and not the compositing. It is also unaffected by
 * -analyzeduration/-probesize (either direction), by setpts alignment
 * of the inputs, by the keyframe interval (a shorter one is worse), and
 * by whether the helper or a hand-run shell spawns it.
 *
 * Three is where the curve is still tolerable. Beyond it, peers stay in
 * the call with their audio and are reported as not drawn — which is
 * the same honest degradation a peer with their camera off already
 * gets, rather than a call that appears to hang. */
#define CALL_TILE_MAX 3

static volatile sig_atomic_t stop_requested;

static bool verbose;
static pthread_mutex_t out_lock = PTHREAD_MUTEX_INITIALIZER;

/* Every line out of this process goes through one of these two, so the
 * "stdout is frames only" rule cannot be broken by a stray printf. */
static void emit(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    pthread_mutex_lock(&out_lock);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    fflush(stderr);
    pthread_mutex_unlock(&out_lock);
    va_end(ap);
}

static void note(const char *fmt, ...) {
    if (!verbose) return;
    va_list ap;
    va_start(ap, fmt);
    pthread_mutex_lock(&out_lock);
    fputs("# ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    fflush(stderr);
    pthread_mutex_unlock(&out_lock);
    va_end(ap);
}

/* JSON string escaping for the few fields that can carry server text. */
static void emit_event(const char *event, const char *key, const char *value) {
    char esc[512];
    size_t n = 0;
    for (const unsigned char *p = (const unsigned char *)(value ? value : "");
         *p && n + 7 < sizeof(esc); p++) {
        if (*p == '"' || *p == '\\') {
            esc[n++] = '\\';
            esc[n++] = (char)*p;
        } else if (*p < 0x20) {
            n += (size_t)snprintf(esc + n, sizeof(esc) - n, "\\u%04x", *p);
        } else {
            esc[n++] = (char)*p;
        }
    }
    esc[n] = 0;
    if (key) emit("{\"event\":\"%s\",\"%s\":\"%s\"}", event, key, esc);
    else emit("{\"event\":\"%s\"}", event);
}

static void on_signal(int sig) {
    (void)sig;
    stop_requested = 1;
}

/* ── One negotiated PeerConnection ────────────────────────────────────── */

struct call;

struct session {
    struct call *owner;
    const char *label; /* "publish" / "subscribe", for the events */
    int pc;
    int audio_track, video_track;
    rtcState state;
    rtcGatheringState gathering;
    /* The WHIP/WHEP session resource, for the DELETE that hangs up. */
    char resource[WHIP_MAX_URL];
    bool have_resource;
    bool active;
    /* Does THIS session's inbound media feed the decoders? Publishing
     * feeds them only in the single-endpoint shape; wiring both ends of
     * a pair would hand our own echo to the speakers. */
    bool receives;
    /* Which peer this is, and therefore which decoder its RTP belongs
     * to. Every subscriber has its OWN legs: N people are N streams,
     * and one decoder fed from several would be a blender. */
    int slot;
};

struct call {
    pthread_mutex_t lock;
    pthread_cond_t cv;
    struct session pub;
    struct session sub[CALL_MAX_PEERS];
    int sub_count;
    struct media_leg send_audio, send_video;
    /* One audio decoder per peer, all playing to the SAME sink — the
     * mixing is the audio system's job and it already does it, which is
     * why N voices need no mixer here.
     *
     * Video is ONE tile, from the first peer. N tiles means a layout
     * policy in the draw path, and that is a deliberate next step
     * rather than something to guess at. */
    struct media_leg recv_audio[CALL_MAX_PEERS];
    /* Video is ONE decoder for everybody, compositing the peers into a
     * single frame: the focused one full size with the rest as
     * thumbnails along the bottom. N decoders would be N processes and
     * N pipes, and the process count is what hurts long before the CPU
     * does — the same reason the audio is one amix.
     *
     * `vlock` is held by the RTP callbacks with TRYLOCK and never
     * waited on: a re-tile forks and reaps ffmpeg, which is far longer
     * than a media thread may be parked, and a dropped RTP packet
     * during a deliberate re-tile is exactly what RTP is for. */
    struct media_mix vmix;
    pthread_mutex_t vlock;
    /* Which peers are actually sending pictures, and the packet
     * counters that decide it. A filter graph STALLS on an input that
     * never produces a frame, so one peer with their camera off would
     * otherwise freeze everybody's video — the set has to be live, not
     * assumed from who connected. */
    _Atomic unsigned long vpkts[CALL_MAX_PEERS];
    unsigned long vseen[CALL_MAX_PEERS];
    int vmisses[CALL_MAX_PEERS];
    bool vlive[CALL_MAX_PEERS];
    /* Which peer is big. An index into the LIVE list, because that is
     * what Tab cycles through. */
    int focus;
    bool want_video;
    int frame_fd;
    /* Borrowed from main's frame, which outlives every thread here. The
     * `frame` verb edits the geometry in it, so a re-tile picks up the
     * new size without a second copy to keep in step. */
    struct media_config *cfg;
    /* Mute is LOCAL and instant: the capture leg keeps running and its
     * packets are dropped on the way to the track. Tearing down ffmpeg
     * instead would make unmuting take as long as a device open, and a
     * mute button with a second of lag is a mute button people talk
     * over. */
    bool muted;
    bool camera_off;
};

static void RTC_API on_state(int pc, rtcState state, void *ptr) {
    (void)pc;
    struct session *s = ptr;
    static const char *const names[] = { "new",          "connecting", "connected",
                                         "disconnected", "failed",     "closed" };
    pthread_mutex_lock(&s->owner->lock);
    s->state = state;
    pthread_cond_broadcast(&s->owner->cv);
    pthread_mutex_unlock(&s->owner->lock);
    if (state >= 0 && (size_t)state < sizeof(names) / sizeof(names[0])) {
        char msg[64];
        snprintf(msg, sizeof(msg), "%s %s", s->label, names[state]);
        emit_event("state", "value", msg);
    }
}

static void RTC_API on_gathering(int pc, rtcGatheringState state, void *ptr) {
    (void)pc;
    struct session *s = ptr;
    pthread_mutex_lock(&s->owner->lock);
    s->gathering = state;
    pthread_cond_broadcast(&s->owner->cv);
    pthread_mutex_unlock(&s->owner->lock);
}

/* An RTP packet arriving on a track, on libdatachannel's thread: hand it
 * straight to the decoder waiting for it on loopback. */
static void RTC_API on_audio_rtp(int id, const char *msg, int size, void *ptr) {
    (void)id;
    struct session *s = ptr;
    if (size > 0 && s->slot >= 0 && s->slot < CALL_MAX_PEERS)
        media_feed(&s->owner->recv_audio[s->slot], msg, (size_t)size);
}

static void RTC_API on_video_rtp(int id, const char *msg, int size, void *ptr) {
    (void)id;
    struct session *s = ptr;
    if (size <= 0 || s->slot < 0 || s->slot >= CALL_MAX_PEERS) return;
    struct call *c = s->owner;
    /* Counted BEFORE the lock and unconditionally: this is what tells
     * the supervisor the peer is alive, and a packet dropped because a
     * re-tile was in progress is still proof they are sending. */
    c->vpkts[s->slot]++;
    /* TRYLOCK, never lock. The only thing holding this is a re-tile,
     * which forks and reaps ffmpeg — far longer than a media thread may
     * be parked. Dropping a datagram is what RTP already expects;
     * stalling libdatachannel's thread is not. */
    if (pthread_mutex_trylock(&c->vlock) != 0) return;
    media_feed(&c->vmix.legs[s->slot], msg, (size_t)size);
    pthread_mutex_unlock(&c->vlock);
}

/* Rebuild the composited picture: who is in it, and who is big.
 *
 * ONE path for three different reasons — a peer started or stopped
 * sending, Tab moved the focus, or shottino resized the window. They
 * are the same operation (new tiles, new decoder, same ports), so they
 * are the same function rather than three that would drift. */
static void video_retile(struct call *c) {
    if (!c->want_video) return;
    int slots[CALL_MAX_PEERS];
    int n = 0;
    for (int i = 0; i < CALL_MAX_PEERS; i++)
        if (c->vlive[i]) slots[n++] = i;

    pthread_mutex_lock(&c->vlock);
    if (n == 0) {
        /* Nobody is sending a picture. The decoder is stopped rather
         * than left running on inputs that produce nothing, which is
         * what makes an audio-only participant cost nothing. */
        media_stop_video_mix(&c->vmix);
        c->vmix.tile_count = 0;
        pthread_mutex_unlock(&c->vlock);
        emit_event("tiles", "value", "");
        return;
    }
    if (c->focus >= n) c->focus = 0;
    c->vmix.tile_count = media_tile_layout(slots, n, c->focus, c->cfg->frame_w, c->cfg->frame_h,
                                           c->vmix.tiles, CALL_TILE_MAX);
    bool ok = media_start_video_mix(&c->vmix, c->cfg, c->frame_fd);
    /* What is ACTUALLY on screen, slot by slot, in draw order. shottino
     * knows which nick each slot is (it built the subscribe list), so
     * this is what lets it label the tiles — and it is also how a cap
     * is reported rather than silently applied: fewer slots here than
     * peers in the call means the window had no room for the rest. */
    char shown[CALL_MAX_PEERS * 4 + 1];
    size_t at = 0;
    int drawn = c->vmix.tile_count;
    for (int i = 0; i < drawn && at + 5 < sizeof(shown); i++) {
        if (i) shown[at++] = ',';
        at += (size_t)snprintf(shown + at, sizeof(shown) - at, "%d", c->vmix.tiles[i].slot);
    }
    shown[at] = 0;
    pthread_mutex_unlock(&c->vlock);

    if (!ok) {
        emit_event("error", "message", "cannot start video decoding");
        return;
    }
    emit_event("tiles", "value", shown);
    if (drawn < n)
        note("video: %d of %d pictures shown — the window has no room for more", drawn, n);
}

/* Who is sending a picture right now, re-examined on a slow tick.
 *
 * Not derived from who CONNECTED: a peer whose camera is off is
 * connected and silent on the video track, and an ffmpeg filter graph
 * blocks forever on an input that never delivers a first frame. One
 * such peer would freeze the whole mix, so membership is measured from
 * arriving packets and nothing else.
 *
 * Asymmetric on purpose: a peer is added the moment a packet arrives,
 * and dropped only after several quiet ticks. Adding late costs a
 * moment of missing thumbnail; dropping early costs a re-tile, and a
 * re-tile on every jittery second is worse than a stale tile. */
static void video_supervise(struct call *c) {
    if (!c->want_video) return;
    bool changed = false;
    for (int i = 0; i < CALL_MAX_PEERS; i++) {
        unsigned long now = c->vpkts[i];
        bool moving = now != c->vseen[i];
        c->vseen[i] = now;
        if (moving) {
            c->vmisses[i] = 0;
            if (!c->vlive[i]) {
                c->vlive[i] = true;
                changed = true;
            }
        } else if (c->vlive[i] && ++c->vmisses[i] >= CALL_TILE_MISSES) {
            c->vlive[i] = false;
            changed = true;
        }
    }
    if (changed) video_retile(c);
}

/* The other direction: whatever the capture ffmpeg packetised, onto the
 * publishing session's tracks. One thread for both legs — these are
 * datagrams on loopback and a poll over two sockets is the whole job. */
static void *pump_main(void *arg) {
    struct call *c = arg;
    static char buf[2048]; /* an RTP packet, MTU-bounded by ffmpeg */
    for (;;) {
        struct pollfd fds[2];
        int n = 0;
        int video_at = -1;
        if (c->send_audio.fd >= 0) {
            fds[n].fd = c->send_audio.fd;
            fds[n].events = POLLIN;
            n++;
        }
        if (c->send_video.fd >= 0) {
            video_at = n;
            fds[n].fd = c->send_video.fd;
            fds[n].events = POLLIN;
            n++;
        }
        if (n == 0) return NULL;
        int rc = poll(fds, (nfds_t)n, 200);
        if (stop_requested) return NULL;
        if (rc <= 0) continue;
        for (int i = 0; i < n; i++) {
            if (!(fds[i].revents & POLLIN)) continue;
            bool is_video = i == video_at;
            int track = is_video ? c->pub.video_track : c->pub.audio_track;
            /* DRAIN the socket, do not take one datagram per wakeup.
             *
             * ffmpeg emits a video frame as a BURST of RTP packets, so
             * one-per-poll delivers a fraction of each frame, the rest
             * is dropped by the socket buffer, and no keyframe ever
             * completes — the far end reports "Invalid data found" on
             * every packet and gives up at a 100% decode error rate.
             * Measured exactly that before this loop existed. */
            for (;;) {
                ssize_t got = recv(fds[i].fd, buf, sizeof(buf), MSG_DONTWAIT);
                if (got <= 0) break;
                /* Muted: dropped HERE rather than at the capture, so
                 * unmuting is instant. The socket is still drained, or
                 * a muted minute would burst on unmute. */
                if (is_video ? c->camera_off : c->muted) continue;
                if (track >= 0) rtcSendMessage(track, buf, (int)got);
            }
        }
    }
}

/* Wait until `done(c)` or the deadline. One helper for every wait, so
 * the timeout accounting cannot drift between them. */
static bool wait_until(struct call *c, bool (*done)(const struct call *), int timeout_ms) {
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += timeout_ms / 1000;
    deadline.tv_nsec += (long)(timeout_ms % 1000) * 1000000L;
    if (deadline.tv_nsec >= 1000000000L) {
        deadline.tv_sec++;
        deadline.tv_nsec -= 1000000000L;
    }
    bool ok;
    pthread_mutex_lock(&c->lock);
    while (!(ok = done(c)) && !stop_requested) {
        if (pthread_cond_timedwait(&c->cv, &c->lock, &deadline) == ETIMEDOUT) {
            ok = done(c);
            break;
        }
    }
    pthread_mutex_unlock(&c->lock);
    return ok;
}

static bool session_settled(const struct session *s) {
    return !s->active || s->state == RTC_CONNECTED || s->state == RTC_FAILED ||
           s->state == RTC_CLOSED;
}

static bool all_gathered(const struct call *c) {
    if (c->pub.active && c->pub.gathering != RTC_GATHERING_COMPLETE) return false;
    for (int i = 0; i < c->sub_count; i++)
        if (c->sub[i].active && c->sub[i].gathering != RTC_GATHERING_COMPLETE) return false;
    return true;
}

/* The PUBLISH is what a call depends on; a peer that never came up is a
 * person who is not here, not a broken call. So the wait ends when
 * publishing has settled and every subscribe has stopped moving. */
static bool all_settled(const struct call *c) {
    if (!session_settled(&c->pub)) return false;
    for (int i = 0; i < c->sub_count; i++)
        if (!session_settled(&c->sub[i])) return false;
    return true;
}

static bool session_up(const struct session *s) { return !s->active || s->state == RTC_CONNECTED; }

static bool publish_up(const struct call *c) { return session_up(&c->pub); }

/* Bring one session all the way up: tracks, offer, POST, answer.
 *
 * `dir` is what decides the shape — SENDRECV for a single-endpoint SFU,
 * SENDONLY/RECVONLY for the publish/subscribe pair. Everything else is
 * identical between them, which is why there is one of these rather than
 * two nearly-identical ones that would drift. */
static bool session_negotiate(struct session *s, const char *url, rtcDirection dir, bool video,
                              const struct media_config *mcfg, const char *stun, int timeout_ms) {
    struct whip_url endpoint;
    if (!whip_url_parse(url, &endpoint)) {
        emit_event("error", "message", "the endpoint is not an http/https URL");
        return false;
    }

    rtcConfiguration config;
    memset(&config, 0, sizeof(config));
    const char *ice[1];
    if (stun) {
        ice[0] = stun;
        config.iceServers = (const char **)ice;
        config.iceServersCount = 1;
    }
    /* NO UDP mux.
     *
     * It looked like the tidy choice — one local port, one firewall
     * rule — and with TWO peer connections in one process it is a
     * collision: both ask libjuice for the same muxed socket and the
     * second never completes ICE, which the SFU reports as "deadline
     * exceeded while waiting connection" and the user sees as a call
     * with sound one way. The mux that matters is the SERVER's
     * (webrtcLocalUDPAddress), and that is unaffected: our side dialling
     * out from ephemeral ports is what every browser already does. */

    s->pc = rtcCreatePeerConnection(&config);
    if (s->pc < 0) {
        emit_event("error", "message", "cannot create the peer connection");
        return false;
    }
    s->active = true;
    rtcSetUserPointer(s->pc, s);
    rtcSetStateChangeCallback(s->pc, on_state);
    rtcSetGatheringStateChangeCallback(s->pc, on_gathering);

    rtcTrackInit audio;
    memset(&audio, 0, sizeof(audio));
    audio.direction = dir;
    audio.codec = RTC_CODEC_OPUS;
    audio.payloadType = mcfg->audio_payload_type; /* the value browsers use for Opus */
    audio.ssrc = mcfg->audio_ssrc;
    audio.mid = "audio";
    audio.name = "shottino";
    audio.msid = "shottino";
    audio.trackId = "audio";
    s->audio_track = rtcAddTrackEx(s->pc, &audio);
    if (s->audio_track < 0) {
        emit_event("error", "message", "cannot add the audio track");
        return false;
    }
    rtcSetUserPointer(s->audio_track, s);
    if (s->receives) rtcSetMessageCallback(s->audio_track, on_audio_rtp);

    if (video) {
        /* VP8 by default and H.264 on request — see media.h for why the
         * choice exists at all. In short: an SFU does not transcode, so
         * the codec is not ours to pick unilaterally. A far end that
         * publishes H.264 while we offer only VP8 produces a call that
         * connects, reports nothing wrong, and shows no picture. */
        rtcTrackInit vid;
        memset(&vid, 0, sizeof(vid));
        vid.direction = dir;
        if (mcfg->video_codec == MEDIA_VIDEO_H264) {
            vid.codec = RTC_CODEC_H264;
            /* Spelled out rather than left NULL: the C API turns a NULL
             * profile into NO fmtp line at all, and an H.264 m-line
             * without packetization-mode is one a browser may decline or
             * read as single-NAL. Constrained Baseline 3.1 is what the
             * capture leg is told to produce. */
            vid.profile = "profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1";
        } else {
            vid.codec = RTC_CODEC_VP8;
        }
        vid.payloadType = mcfg->video_payload_type;
        vid.ssrc = mcfg->video_ssrc;
        vid.mid = "video";
        vid.name = "shottino";
        vid.msid = "shottino";
        vid.trackId = "video";
        s->video_track = rtcAddTrackEx(s->pc, &vid);
        if (s->video_track < 0) {
            emit_event("error", "message", "cannot add the video track");
            return false;
        }
        rtcSetUserPointer(s->video_track, s);
        if (s->receives) rtcSetMessageCallback(s->video_track, on_video_rtp);
    }

    /* Vanilla ICE: gather everything, THEN offer.
     *
     * WHIP is one POST with one body, so there is nowhere to trickle a
     * late candidate to — the offer that goes in the request has to be
     * complete. (The spec has a PATCH for trickle; servers vary, and
     * needing it is not worth the second code path here.) */
    note("%s: gathering ICE candidates", s->label);
    if (rtcSetLocalDescription(s->pc, "offer") < 0) {
        emit_event("error", "message", "cannot create the offer");
        return false;
    }
    if (!wait_until(s->owner, all_gathered, timeout_ms)) {
        emit_event("error", "message", "ICE gathering did not finish in time");
        return false;
    }

    static char offer[64 * 1024];
    if (rtcGetLocalDescription(s->pc, offer, (int)sizeof(offer)) < 0) {
        emit_event("error", "message", "cannot read the local description");
        return false;
    }
    note("%s: offer is %zu bytes, posting to %s", s->label, strlen(offer), url);

    struct whip_response resp;
    char err[256] = { 0 };
    if (!whip_request(&endpoint, "POST", "application/sdp", offer, timeout_ms, &resp, err,
                      sizeof(err))) {
        emit_event("error", "message", err[0] ? err : "the request failed");
        return false;
    }
    /* 201 is what the spec says; some servers answer 200. Anything else
     * is reported WITH its status, because "it did not work" without the
     * number is the kind of message that wastes an afternoon. */
    if (resp.status != 201 && resp.status != 200) {
        char msg[128];
        snprintf(msg, sizeof(msg), "%s: the endpoint answered %d", s->label, resp.status);
        emit_event("error", "message", msg);
        whip_response_free(&resp);
        return false;
    }
    if (!resp.body || !resp.body_len) {
        emit_event("error", "message", "the endpoint returned no SDP answer");
        whip_response_free(&resp);
        return false;
    }

    /* The resource URL, for the DELETE that hangs up. Resolved now,
     * while the request URL it is relative to is still in hand. */
    s->have_resource =
        resp.location[0] && whip_resolve(&endpoint, resp.location, s->resource, sizeof(s->resource));
    if (resp.location[0] && !s->have_resource)
        note("%s: the Location header could not be resolved: %s", s->label, resp.location);

    bool ok = rtcSetRemoteDescription(s->pc, resp.body, "answer") >= 0;
    if (!ok) emit_event("error", "message", "the SDP answer was rejected");
    whip_response_free(&resp);
    return ok;
}

/* Hanging up is a DELETE, and it is owed on EVERY path that got a
 * resource — a rejected answer and a media path that never came up
 * included. An SFU that never hears it holds the slot until its own
 * timeout, which for a room somebody is trying to re-enter is the
 * difference between "call again" and "wait five minutes". */
static void session_release(struct session *s) {
    if (s->have_resource) {
        struct whip_url res;
        if (whip_url_parse(s->resource, &res)) {
            struct whip_response bye;
            char err[256] = { 0 };
            if (whip_request(&res, "DELETE", NULL, NULL, 5000, &bye, err, sizeof(err))) {
                note("%s: hangup returned %d", s->label, bye.status);
                whip_response_free(&bye);
            } else {
                note("%s: hangup failed: %s", s->label, err);
            }
        }
        s->have_resource = false;
    }
    if (s->pc >= 0) {
        rtcDeletePeerConnection(s->pc);
        s->pc = -1;
    }
    s->active = false;
}

static void usage(FILE *out) {
    fprintf(out,
            "usage: shottino-call [--whip <url>] [--whep <url>] [options]\n"
            "\n"
            "  --whip <url>     publish here. Alone, the session is sendrecv\n"
            "  --whep <url>     subscribe here. With --whip, publishing becomes\n"
            "                   sendonly and this is the receiving session — the\n"
            "                   shape MediaMTX needs. Alone, watch without\n"
            "                   publishing: no camera, no microphone\n"
            "  --stun <url>     a STUN server, e.g. stun:stun.example:19302\n"
            "  --video          negotiate a video track as well as audio\n"
            "  --timeout <ms>   how long to wait for ICE and for the answer "
            "(default 15000)\n"
            "  --audio-source <f:i>  ffmpeg capture, e.g. pulse:default\n"
            "  --video-source <f:i>  ffmpeg camera, e.g. v4l2:/dev/video0\n"
            "  --audio-sink <f:d>    where decoded audio plays, e.g. pulse:default\n"
            "  --frame <WxH>    what we DECODE to, in pixels (default 320x240)\n"
            "  --capture <WxH[@fps]>  what we SEND (default 640x480@20) — the far end\n"
            "                   may be a browser, so this is not the render size\n"
            "  --bitrate <kbps> video bitrate we send (default 800)\n"
            "  --video-codec <c>  vp8 (default) or h264. An SFU does not transcode,\n"
            "                   so this has to match what the far end publishes\n"
            "  --fps <n>        video frame rate (default 10)\n"
            "  --verbose        interleave '#' notes on stderr\n"
            "  --protocol       print the helper protocol version and exit\n"
            "\n"
            "Control verbs on stdin, one per line: mute, unmute, camera on, camera off,\n"
            "hangup. Events are JSON lines on stderr; stdout carries rgb24 frames.\n");
}

int main(int argc, char **argv) {
    const char *whip_url = NULL;
    const char *whep_urls[CALL_MAX_PEERS];
    int whep_count = 0;
    const char *stun = NULL;
    bool video = false;
    int timeout_ms = 15000;
    /* Payload types and SSRCs are declared ONCE, here, and travel to
     * both the offer and the ffmpeg legs — a second copy of "Opus is
     * 111" is a second place for it to stop being true. */
    struct media_config mcfg = { .audio_source = "pulse:default",
                                 .video_source = "v4l2:/dev/video0",
                                 .audio_sink = "pulse:default",
                                 .audio_payload_type = 111,
                                 .video_payload_type = 96,
                                 .audio_ssrc = 1,
                                 .video_ssrc = 2,
                                 .frame_w = 320,
                                 .frame_h = 240,
                                 .fps = 10,
                                 .capture_w = 640,
                                 .capture_h = 480,
                                 .capture_fps = 20,
                                 .video_kbps = 800,
                                 .video_codec = MEDIA_VIDEO_VP8,
                                 .want_video = false };

    enum { OPT_AUDIO_SRC = 1000, OPT_VIDEO_SRC, OPT_AUDIO_SINK, OPT_FRAME, OPT_FPS, OPT_WHEP,
           OPT_CAPTURE, OPT_KBPS, OPT_VCODEC };
    static const struct option opts[] = {
        { "whip", required_argument, NULL, 'w' },
        { "whep", required_argument, NULL, OPT_WHEP },
        { "stun", required_argument, NULL, 's' },
        { "video", no_argument, NULL, 'V' },
        { "timeout", required_argument, NULL, 't' },
        { "audio-source", required_argument, NULL, OPT_AUDIO_SRC },
        { "video-source", required_argument, NULL, OPT_VIDEO_SRC },
        { "audio-sink", required_argument, NULL, OPT_AUDIO_SINK },
        { "frame", required_argument, NULL, OPT_FRAME },
        { "capture", required_argument, NULL, OPT_CAPTURE },
        { "bitrate", required_argument, NULL, OPT_KBPS },
        { "video-codec", required_argument, NULL, OPT_VCODEC },
        { "fps", required_argument, NULL, OPT_FPS },
        { "verbose", no_argument, NULL, 'v' },
        { "protocol", no_argument, NULL, 'p' },
        { "help", no_argument, NULL, 'h' },
        { NULL, 0, NULL, 0 }
    };
    int c;
    while ((c = getopt_long(argc, argv, "w:s:Vt:vph", opts, NULL)) != -1) {
        switch (c) {
        case 'w': whip_url = optarg; break;
        case OPT_WHEP:
            /* Repeatable: one per person in the call. */
            if (whep_count < CALL_MAX_PEERS) whep_urls[whep_count++] = optarg;
            else emit_event("error", "message", "too many peers — extra --whep ignored");
            break;
        case 's': stun = optarg; break;
        case 'V': video = true; break;
        case 't': timeout_ms = atoi(optarg); break;
        case OPT_AUDIO_SRC: mcfg.audio_source = optarg; break;
        case OPT_VIDEO_SRC: mcfg.video_source = optarg; break;
        case OPT_AUDIO_SINK: mcfg.audio_sink = optarg; break;
        case OPT_FRAME:
            /* The helper has no terminal, so it must never guess the
             * geometry — shottino computes it from the cells it has. */
            if (sscanf(optarg, "%dx%d", &mcfg.frame_w, &mcfg.frame_h) != 2 || mcfg.frame_w <= 0 ||
                mcfg.frame_h <= 0) {
                emit_event("error", "message", "--frame wants WxH, e.g. 320x240");
                return 2;
            }
            break;
        case OPT_CAPTURE:
            if (sscanf(optarg, "%dx%d@%d", &mcfg.capture_w, &mcfg.capture_h, &mcfg.capture_fps) < 2 ||
                mcfg.capture_w <= 0 || mcfg.capture_h <= 0) {
                emit_event("error", "message", "--capture wants WxH or WxH@fps, e.g. 640x480@20");
                return 2;
            }
            break;
        case OPT_KBPS: mcfg.video_kbps = atoi(optarg); break;
        case OPT_VCODEC:
            /* Refused rather than defaulted: asking for h264 and
             * silently getting VP8 is the exact failure this is for. */
            if (!media_video_codec_parse(optarg, &mcfg.video_codec)) {
                emit_event("error", "message", "--video-codec wants vp8 or h264");
                return 2;
            }
            break;
        case OPT_FPS: mcfg.fps = atoi(optarg); break;
        case 'v': verbose = true; break;
        case 'p': printf("%d\n", CALL_PROTOCOL); return 0;
        case 'h': usage(stdout); return 0;
        default: usage(stderr); return 2;
        }
    }
    if (!whip_url && whep_count == 0) {
        usage(stderr);
        return 2;
    }
    if (timeout_ms < 1000) timeout_ms = 1000;
    mcfg.want_video = video;
    if (mcfg.fps < 1 || mcfg.fps > 30) mcfg.fps = 10;
    if (mcfg.capture_fps < 1 || mcfg.capture_fps > 60) mcfg.capture_fps = 20;

    /* SIGPIPE would kill the process the moment shottino closes the
     * frame pipe; the read/write paths report the error instead. */
    signal(SIGPIPE, SIG_IGN);
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    rtcInitLogger(verbose ? RTC_LOG_WARNING : RTC_LOG_NONE, NULL);

    struct call call;
    memset(&call, 0, sizeof(call));
    pthread_mutex_init(&call.lock, NULL);
    pthread_cond_init(&call.cv, NULL);
    call.pub.owner = &call;
    call.pub.label = "publish";
    call.pub.pc = -1;
    call.pub.audio_track = call.pub.video_track = -1;
    call.pub.slot = -1;
    call.sub_count = whep_count;
    for (int i = 0; i < CALL_MAX_PEERS; i++) {
        call.sub[i].owner = &call;
        call.sub[i].label = "subscribe";
        call.sub[i].pc = -1;
        call.sub[i].audio_track = call.sub[i].video_track = -1;
        call.sub[i].slot = i;
        call.recv_audio[i].fd = -1;
        call.recv_audio[i].pid = -1;
    }
    call.send_audio.fd = call.send_video.fd = -1;
    call.send_audio.pid = call.send_video.pid = -1;
    pthread_mutex_init(&call.vlock, NULL);
    call.vmix.pid = -1;
    for (int i = 0; i < MEDIA_MAX_PEERS; i++) {
        call.vmix.legs[i].fd = -1;
        call.vmix.legs[i].pid = -1;
    }
    call.want_video = video;
    call.frame_fd = STDOUT_FILENO;
    call.cfg = &mcfg;

    /* Which session receives, and therefore which direction each one
     * negotiates. Decided ONCE, here, so nothing downstream has to work
     * it out again and reach a different answer. */
    bool paired = whip_url && whep_count > 0;
    for (int i = 0; i < whep_count; i++) call.sub[i].receives = true;
    call.pub.receives = whip_url && whep_count == 0;

    pthread_t pump = 0;
    bool pumping = false;
    bool ok = true;
    if (whip_url)
        ok = session_negotiate(&call.pub, whip_url,
                               paired ? RTC_DIRECTION_SENDONLY : RTC_DIRECTION_SENDRECV, video,
                               &mcfg, stun, timeout_ms);
    /* Capture starts as soon as the SFU has ACCEPTED the publish, not
     * after the connection completes.
     *
     * MediaMTX allows about two seconds from peer-connection to first
     * RTP and then drops the publisher with "deadline exceeded while
     * waiting tracks" — after which every WHEP read is a 404 and the
     * failure looks like a subscribe bug. ffmpeg cannot fork, exec, open
     * a device and encode a first frame inside that window if it only
     * starts once ICE is done, so it gets its head start while ICE runs
     * and the pump delivers the moment the track is up.
     *
     * The device still does not open until the SFU said yes, which is
     * the gate that matters: a call nobody accepted never lights the
     * microphone. */
    if (ok && whip_url) {
        if (!media_start_send(&call.send_audio, &mcfg, false))
            emit_event("error", "message", "cannot open the microphone");
        if (video && !media_start_send(&call.send_video, &mcfg, true))
            emit_event("error", "message", "cannot open the camera");
        pumping = pthread_create(&pump, NULL, pump_main, &call) == 0;
    }

    /* The subscribe waits for the publish to be CONNECTED, not merely
     * accepted.
     *
     * An SFU that separates the two has nothing to read until a
     * publisher is actually live: MediaMTX answers the WHEP POST with a
     * 404 if the path has no active publisher, and the publish is not
     * active the instant its own POST returns — ICE still has to
     * complete. Measured against a real server, which is the only place
     * this shows: a stub answers the same either way. */
    if (ok && whep_count > 0 && whip_url) {
        note("subscribe: waiting for the publish to come up");
        if (!wait_until(&call, publish_up, timeout_ms)) {
            emit_event("error", "message",
                       "the publish never connected — check the SFU's advertised public IP");
            ok = false;
        }
    }
    /* Every peer gets its own session, and a peer that FAILS does not
     * fail the call: in a channel most members are not in it, so their
     * path has no publisher and the SFU rightly says 404. That is a
     * person who is not here, reported and stepped over. */
    int joined = 0;
    for (int i = 0; ok && i < whep_count; i++) {
        if (session_negotiate(&call.sub[i], whep_urls[i], RTC_DIRECTION_RECVONLY,
                              video && i == 0, &mcfg, stun, timeout_ms))
            joined++;
        else
            note("subscribe %d: not in the call", i);
    }
    if (whep_count > 0 && joined == 0 && !whip_url) {
        emit_event("error", "message", "nobody is in this call yet");
        ok = false;
    }

    bool connected = false;
    if (ok) {
        emit_event("negotiated", "resource",
                   call.pub.have_resource ? call.pub.resource : call.sub[0].resource);
        /* Connected means OUR end is up. A peer who never answered is
         * absent, not a failure — otherwise one silent member of a
         * channel would end everybody else's call. */
        connected = wait_until(&call, all_settled, timeout_ms) && session_up(&call.pub);
        if (!connected && !stop_requested)
            emit_event("error", "message",
                       "the media path never came up — check the SFU's advertised public IP");
    }

    if (connected) {
        /* Devices open AFTER the connection is up, never before: opening
         * a microphone for a call that then fails to connect turns a
         * negotiation error into a recording light nobody asked for. A
         * watch-only session opens neither. */
        bool sending = whip_url != NULL;
        int voices = call.pub.receives ? 1 : 0;
        for (int i = 0; i < call.sub_count; i++)
            if (call.sub[i].active && call.sub[i].state == RTC_CONNECTED) voices = i + 1;
        /* ONE decoder for all of them. N voices used to be N processes
         * letting the audio system mix; that works and does not scale,
         * and the process count is what hurts long before the CPU. */
        if (voices > 0 && !media_start_mix(call.recv_audio, voices, &mcfg))
            emit_event("error", "message", "cannot start audio playback (is ffmpeg installed?)");
        /* The video decoder is NOT started here. It cannot be: its
         * inputs are the peers actually sending pictures, and at this
         * instant not one packet has arrived. video_supervise() starts
         * it a tick later, when there is something to decode — which is
         * the same path that adds a late joiner and drops somebody who
         * turned their camera off. */
        emit_event("media", "value",
                   sending ? (video ? "audio+video" : "audio")
                           : (video ? "watching audio+video" : "watching audio"));
    }

    /* Control lines on stdin, one verb per line. Blocking reads on a
     * pipe shottino owns; poll so a closed pipe or a signal ends the
     * call rather than parking this thread forever. */
    time_t last_tile_check = 0;
    while (connected && !stop_requested) {
        struct pollfd in = { .fd = STDIN_FILENO, .events = POLLIN, .revents = 0 };
        int rc = poll(&in, 1, 200);
        if (rc > 0 && (in.revents & POLLIN)) {
            char line[64];
            ssize_t got = read(STDIN_FILENO, line, sizeof(line) - 1);
            if (got <= 0) break; /* shottino closed the pipe: hang up */
            line[got] = 0;
            line[strcspn(line, "\r\n")] = 0;
            if (strcmp(line, "mute") == 0) call.muted = true;
            else if (strcmp(line, "unmute") == 0) call.muted = false;
            else if (strcmp(line, "camera off") == 0) call.camera_off = true;
            else if (strcmp(line, "camera on") == 0) call.camera_off = false;
            else if (strcmp(line, "hangup") == 0) break;
            else if (strcmp(line, "focus next") == 0) {
                /* Cycles the LIVE list, which is what is on screen —
                 * stepping through peers who are not sending a picture
                 * would be a Tab that visibly does nothing. */
                int live = 0;
                for (int i = 0; i < CALL_MAX_PEERS; i++) live += call.vlive[i] ? 1 : 0;
                if (live > 1) {
                    call.focus = (call.focus + 1) % live;
                    video_retile(&call);
                }
            } else if (strncmp(line, "focus ", 6) == 0) {
                call.focus = atoi(line + 6);
                video_retile(&call);
            } else if (strncmp(line, "frame ", 6) == 0) {
                /* The window changed size or the call moved between the
                 * corner box and its own window. The helper still never
                 * GUESSES a geometry — it is told one, exactly as at
                 * startup — but it is no longer told only once. */
                int w = 0, h = 0;
                if (sscanf(line + 6, "%dx%d", &w, &h) == 2 && w > 0 && h > 0) {
                    mcfg.frame_w = w;
                    mcfg.frame_h = h;
                    video_retile(&call);
                }
            }
            else if (line[0]) continue; /* unknown verb: never fatal */
            emit_event("control", "value", line);
        }
        /* Who is sending a picture, on a slow tick. See
         * video_supervise(): membership cannot be assumed from who
         * connected, or one peer with the camera off freezes the mix. */
        time_t now = time(NULL);
        if (connected && call.want_video && now - last_tile_check >= CALL_TILE_TICK_SECS) {
            last_tile_check = now;
            video_supervise(&call);
        }
        pthread_mutex_lock(&call.lock);
        bool still = session_up(&call.pub);
        pthread_mutex_unlock(&call.lock);
        if (!still) break;
    }

    stop_requested = 1; /* ends the pump */
    if (pumping) pthread_join(pump, NULL);
    media_stop(&call.send_audio);
    media_stop(&call.send_video);
    for (int i = 0; i < CALL_MAX_PEERS; i++) media_stop(&call.recv_audio[i]);
    media_free_video_mix(&call.vmix);
    session_release(&call.pub);
    for (int i = 0; i < CALL_MAX_PEERS; i++) session_release(&call.sub[i]);
    rtcCleanup();
    emit_event("closed", NULL, NULL);
    return connected ? 0 : 1;
}
