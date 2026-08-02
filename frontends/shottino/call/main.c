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
 * This stage does the SIGNALLING and nothing else: it negotiates a real
 * WebRTC session against a WHIP endpoint and reports what happened.
 * Piping ffmpeg into and out of the tracks is the next stage, and the
 * shape here is built for it — the tracks are already declared sendrecv
 * with the codecs the media legs will use.
 *
 * Output contract (already what the media stage needs):
 *   stdout — reserved for the raw frame stream. NOTHING else writes here.
 *   stderr — one JSON object per line: {"event":…}. With --verbose,
 *            human notes are interleaved as `#` comment lines, which a
 *            parser skips on the first character.
 */
#include "whip.h"

#include <errno.h>
#include <getopt.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <rtc/rtc.h>

/* The helper↔shottino contract version. shottino runs `shottino-call
 * --protocol` and refuses a number it does not know, so a helper left
 * behind by an older install fails LOUDLY instead of misbehaving. */
#define CALL_PROTOCOL 1

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
    for (const unsigned char *p = (const unsigned char *)(value ? value : ""); *p && n + 7 < sizeof(esc); p++) {
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

/* ── Negotiation state, shared with libdatachannel's callback threads ── */

struct call {
    int pc;
    pthread_mutex_t lock;
    pthread_cond_t cv;
    rtcState state;
    rtcGatheringState gathering;
};

static void RTC_API on_state(int pc, rtcState state, void *ptr) {
    (void)pc;
    struct call *c = ptr;
    static const char *const names[] = { "new",          "connecting", "connected",
                                         "disconnected", "failed",     "closed" };
    pthread_mutex_lock(&c->lock);
    c->state = state;
    pthread_cond_broadcast(&c->cv);
    pthread_mutex_unlock(&c->lock);
    if (state >= 0 && (size_t)state < sizeof(names) / sizeof(names[0]))
        emit_event("state", "value", names[state]);
}

static void RTC_API on_gathering(int pc, rtcGatheringState state, void *ptr) {
    (void)pc;
    struct call *c = ptr;
    pthread_mutex_lock(&c->lock);
    c->gathering = state;
    pthread_cond_broadcast(&c->cv);
    pthread_mutex_unlock(&c->lock);
}

/* Wait until `done(c)` or the deadline. One helper for both waits, so
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

static bool gathered(const struct call *c) { return c->gathering == RTC_GATHERING_COMPLETE; }

static bool settled(const struct call *c) {
    return c->state == RTC_CONNECTED || c->state == RTC_FAILED || c->state == RTC_CLOSED;
}

static void usage(FILE *out) {
    fprintf(out,
            "usage: shottino-call --whip <url> [options]\n"
            "\n"
            "  --whip <url>     the WHIP endpoint to negotiate against (required)\n"
            "  --stun <url>     a STUN server, e.g. stun:stun.example:19302\n"
            "  --video          negotiate a video track as well as audio\n"
            "  --timeout <ms>   how long to wait for ICE and for the answer "
            "(default 15000)\n"
            "  --verbose        interleave '#' notes on stderr\n"
            "  --protocol       print the helper protocol version and exit\n"
            "\n"
            "Events are JSON lines on stderr. stdout is reserved for media frames.\n");
}

int main(int argc, char **argv) {
    const char *whip_url = NULL;
    const char *stun = NULL;
    bool video = false;
    int timeout_ms = 15000;

    static const struct option opts[] = {
        { "whip", required_argument, NULL, 'w' },  { "stun", required_argument, NULL, 's' },
        { "video", no_argument, NULL, 'V' },       { "timeout", required_argument, NULL, 't' },
        { "verbose", no_argument, NULL, 'v' },     { "protocol", no_argument, NULL, 'p' },
        { "help", no_argument, NULL, 'h' },        { NULL, 0, NULL, 0 }
    };
    int c;
    while ((c = getopt_long(argc, argv, "w:s:Vt:vph", opts, NULL)) != -1) {
        switch (c) {
        case 'w': whip_url = optarg; break;
        case 's': stun = optarg; break;
        case 'V': video = true; break;
        case 't': timeout_ms = atoi(optarg); break;
        case 'v': verbose = true; break;
        case 'p': printf("%d\n", CALL_PROTOCOL); return 0;
        case 'h': usage(stdout); return 0;
        default: usage(stderr); return 2;
        }
    }
    if (!whip_url) {
        usage(stderr);
        return 2;
    }
    if (timeout_ms < 1000) timeout_ms = 1000;

    struct whip_url endpoint;
    if (!whip_url_parse(whip_url, &endpoint)) {
        emit_event("error", "message", "the WHIP endpoint is not an http/https URL");
        return 1;
    }

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

    rtcConfiguration config;
    memset(&config, 0, sizeof(config));
    const char *ice[1];
    if (stun) {
        ice[0] = stun;
        config.iceServers = (const char **)ice;
        config.iceServersCount = 1;
    }
    /* One UDP port for everything, which is what the far side expects
     * and what makes a firewall rule writable. */
    config.enableIceUdpMux = true;

    call.pc = rtcCreatePeerConnection(&config);
    if (call.pc < 0) {
        emit_event("error", "message", "cannot create the peer connection");
        return 1;
    }
    rtcSetUserPointer(call.pc, &call);
    rtcSetStateChangeCallback(call.pc, on_state);
    rtcSetGatheringStateChangeCallback(call.pc, on_gathering);

    /* Sendrecv from the start: this is a CALL, not a broadcast, and
     * renegotiating a direction later would mean a second offer/answer
     * the WHIP resource has no room for. */
    rtcTrackInit audio;
    memset(&audio, 0, sizeof(audio));
    audio.direction = RTC_DIRECTION_SENDRECV;
    audio.codec = RTC_CODEC_OPUS;
    audio.payloadType = 111; /* the value browsers use for Opus */
    audio.ssrc = 1;
    audio.mid = "audio";
    audio.name = "shottino";
    audio.msid = "shottino";
    audio.trackId = "audio";
    if (rtcAddTrackEx(call.pc, &audio) < 0) {
        emit_event("error", "message", "cannot add the audio track");
        rtcDeletePeerConnection(call.pc);
        return 1;
    }
    if (video) {
        /* VP8 is the safest common denominator: universally supported
         * and free of the licensing baggage that keeps H.264 out of
         * some distributions. The terminal renders ASCII art, so the
         * detail H.264 would buy is thrown away on arrival anyway. */
        rtcTrackInit vid;
        memset(&vid, 0, sizeof(vid));
        vid.direction = RTC_DIRECTION_SENDRECV;
        vid.codec = RTC_CODEC_VP8;
        vid.payloadType = 96;
        vid.ssrc = 2;
        vid.mid = "video";
        vid.name = "shottino";
        vid.msid = "shottino";
        vid.trackId = "video";
        if (rtcAddTrackEx(call.pc, &vid) < 0) {
            emit_event("error", "message", "cannot add the video track");
            rtcDeletePeerConnection(call.pc);
            return 1;
        }
    }

    /* Vanilla ICE: gather everything, THEN offer.
     *
     * WHIP is one POST with one body, so there is nowhere to trickle a
     * late candidate to — the offer that goes in the request has to be
     * complete. (The spec has a PATCH for trickle; servers vary, and
     * needing it is not worth the second code path here.) */
    note("gathering ICE candidates");
    if (rtcSetLocalDescription(call.pc, "offer") < 0) {
        emit_event("error", "message", "cannot create the offer");
        rtcDeletePeerConnection(call.pc);
        return 1;
    }
    if (!wait_until(&call, gathered, timeout_ms)) {
        emit_event("error", "message", "ICE gathering did not finish in time");
        rtcDeletePeerConnection(call.pc);
        return 1;
    }

    static char offer[64 * 1024];
    if (rtcGetLocalDescription(call.pc, offer, (int)sizeof(offer)) < 0) {
        emit_event("error", "message", "cannot read the local description");
        rtcDeletePeerConnection(call.pc);
        return 1;
    }
    note("offer is %zu bytes, posting to %s", strlen(offer), whip_url);

    struct whip_response resp;
    char err[256] = { 0 };
    if (!whip_request(&endpoint, "POST", "application/sdp", offer, timeout_ms, &resp, err,
                      sizeof(err))) {
        emit_event("error", "message", err[0] ? err : "the WHIP request failed");
        rtcDeletePeerConnection(call.pc);
        return 1;
    }
    /* 201 is what the spec says; some servers answer 200. Anything else
     * is reported WITH its status, because "it did not work" without the
     * number is the kind of message that wastes an afternoon. */
    if (resp.status != 201 && resp.status != 200) {
        char msg[128];
        snprintf(msg, sizeof(msg), "the WHIP endpoint answered %d", resp.status);
        emit_event("error", "message", msg);
        whip_response_free(&resp);
        rtcDeletePeerConnection(call.pc);
        return 1;
    }
    if (!resp.body || !resp.body_len) {
        emit_event("error", "message", "the WHIP endpoint returned no SDP answer");
        whip_response_free(&resp);
        rtcDeletePeerConnection(call.pc);
        return 1;
    }

    /* The resource URL, for the DELETE that hangs up. Resolved now,
     * while the request URL it is relative to is still in hand. */
    char resource[WHIP_MAX_URL] = { 0 };
    bool have_resource = resp.location[0] &&
                         whip_resolve(&endpoint, resp.location, resource, sizeof(resource));
    if (resp.location[0] && !have_resource)
        note("the Location header could not be resolved: %s", resp.location);

    bool connected = false;
    if (rtcSetRemoteDescription(call.pc, resp.body, "answer") < 0) {
        /* Falls THROUGH to the hangup below rather than returning: the
         * session resource exists from the moment the endpoint answered
         * 201, so every exit from here on owes it a DELETE. */
        emit_event("error", "message", "the SDP answer was rejected");
    } else {
        emit_event("negotiated", have_resource ? "resource" : NULL, resource);
        connected = wait_until(&call, settled, timeout_ms) && call.state == RTC_CONNECTED;
        if (!connected && !stop_requested)
            emit_event("error", "message",
                       "the media path never came up — check the SFU's advertised public IP");
        /* Connected: this stage has nothing to send yet, so it holds the
         * session open until asked to stop. The media legs land here. */
        while (connected && !stop_requested) {
            struct timespec tick = { .tv_sec = 0, .tv_nsec = 200 * 1000 * 1000 };
            nanosleep(&tick, NULL);
            pthread_mutex_lock(&call.lock);
            bool still = call.state == RTC_CONNECTED;
            pthread_mutex_unlock(&call.lock);
            if (!still) break;
        }
    }
    whip_response_free(&resp);

    /* Hanging up is a DELETE, and it is owed on EVERY path that got a
     * resource — a rejected answer and a media path that never came up
     * included. An SFU that never hears it holds the slot until its own
     * timeout, which for a room somebody is trying to re-enter is the
     * difference between "call again" and "wait five minutes". */
    if (have_resource) {
        struct whip_url res_url;
        if (whip_url_parse(resource, &res_url)) {
            struct whip_response bye;
            char bye_err[256] = { 0 };
            if (whip_request(&res_url, "DELETE", NULL, NULL, 5000, &bye, bye_err, sizeof(bye_err))) {
                note("hangup returned %d", bye.status);
                whip_response_free(&bye);
            } else {
                note("hangup failed: %s", bye_err);
            }
        }
    }

    rtcDeletePeerConnection(call.pc);
    rtcCleanup();
    emit_event("closed", NULL, NULL);
    return connected ? 0 : 1;
}
