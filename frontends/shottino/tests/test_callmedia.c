/* test_callmedia — the one pure thing in the media legs.
 *
 * Everything else in media.c is fork+exec and sockets, verified by
 * running it (see docs/CALLS.md). The SDP is the exception and the one
 * that most deserves a test: a wrong payload type or rtpmap here is a
 * decoder that sits SILENT with no error at all, which is the least
 * debuggable failure this design has.
 *
 * Links media.c only — no libdatachannel — so the default gate never
 * depends on the opt-in submodule having been built.
 */
#include "../call/media.h"

#include <string.h>

#include <unistd.h>

#include "test.h"

TEST(the_receive_sdp_describes_what_was_negotiated) {
    struct media_config cfg = { .audio_source = "pulse:default",
                                .video_source = "v4l2:/dev/video0",
                                .audio_sink = "pulse:default",
                                .audio_payload_type = 111,
                                .video_payload_type = 96,
                                .audio_ssrc = 1,
                                .video_ssrc = 2,
                                .frame_w = 320,
                                .frame_h = 240,
                                .fps = 10,
                                .want_video = true };
    char sdp[512];

    CHECK(media_recv_sdp(&cfg, true, 45123, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "m=video 45123 RTP/AVP 96") != NULL);
    CHECK(strstr(sdp, "a=rtpmap:96 VP8/90000") != NULL);
    /* Loopback, because that is the only place the helper writes. */
    CHECK(strstr(sdp, "c=IN IP4 127.0.0.1") != NULL);

    CHECK(media_recv_sdp(&cfg, false, 45125, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "m=audio 45125 RTP/AVP 111") != NULL);
    CHECK(strstr(sdp, "a=rtpmap:111 opus/48000/2") != NULL);

    /* The payload type FOLLOWS the negotiation rather than being spelled
     * again here: the offer and the decoder have to agree, and two
     * copies of "Opus is 111" is one of them going stale. */
    cfg.audio_payload_type = 120;
    cfg.video_payload_type = 100;
    CHECK(media_recv_sdp(&cfg, true, 1, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "RTP/AVP 100") != NULL);
    CHECK(strstr(sdp, "a=rtpmap:100 VP8/90000") != NULL);
    CHECK(media_recv_sdp(&cfg, false, 1, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "a=rtpmap:120 opus/48000/2") != NULL);

    /* Refused rather than half-written: a truncated SDP is a decoder
     * that starts and then understands nothing. */
    char tiny[16];
    CHECK(!media_recv_sdp(&cfg, true, 45123, tiny, sizeof(tiny)));
    CHECK(!media_recv_sdp(&cfg, true, 0, sdp, sizeof(sdp)));
    CHECK(!media_recv_sdp(NULL, true, 45123, sdp, sizeof(sdp)));
}

/* An SFU does not transcode, so the codec is not ours to pick alone: a
 * far end publishing H.264 to a helper that offered VP8 is a call that
 * connects, reports nothing wrong, and shows no picture. The decoder
 * has to be told the same thing the offer said. */
TEST(the_receive_sdp_follows_the_negotiated_video_codec) {
    struct media_config cfg = { .video_payload_type = 96, .video_codec = MEDIA_VIDEO_VP8 };
    char sdp[512];

    CHECK(media_recv_sdp(&cfg, true, 5000, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "a=rtpmap:96 VP8/90000") != NULL);
    /* VP8 gets NO fmtp rather than an empty one. */
    CHECK(strstr(sdp, "a=fmtp:") == NULL);

    cfg.video_codec = MEDIA_VIDEO_H264;
    CHECK(media_recv_sdp(&cfg, true, 5000, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "a=rtpmap:96 H264/90000") != NULL);
    /* Without this the depacketiser assumes single-NAL and drops every
     * fragmented keyframe — i.e. all of them. */
    CHECK(strstr(sdp, "a=fmtp:96 packetization-mode=1") != NULL);

    /* Audio is unaffected by the video codec. */
    cfg.audio_payload_type = 111;
    CHECK(media_recv_sdp(&cfg, false, 5001, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "a=rtpmap:111 opus/48000/2") != NULL);
    CHECK(strstr(sdp, "H264") == NULL);
}

/* The spelling a user types, and the one wrong answer that must not be
 * given: falling back to a default when asked for something specific. */
TEST(the_video_codec_is_parsed_or_refused) {
    enum media_video_codec got = MEDIA_VIDEO_H264;
    CHECK(media_video_codec_parse("vp8", &got) && got == MEDIA_VIDEO_VP8);
    CHECK(media_video_codec_parse("VP8", &got) && got == MEDIA_VIDEO_VP8);
    CHECK(media_video_codec_parse("h264", &got) && got == MEDIA_VIDEO_H264);
    CHECK(media_video_codec_parse("H.264", &got) && got == MEDIA_VIDEO_H264);

    CHECK(!media_video_codec_parse("vp9", &got));
    CHECK(!media_video_codec_parse("", &got));
    CHECK(!media_video_codec_parse(NULL, &got));
    /* Refused means UNCHANGED: a rejected word that had already
     * overwritten the setting would be the silent-default bug wearing a
     * return value. */
    CHECK(got == MEDIA_VIDEO_H264);

    CHECK(strcmp(media_video_codec_name(MEDIA_VIDEO_VP8), "VP8") == 0);
    CHECK(strcmp(media_video_codec_name(MEDIA_VIDEO_H264), "H264") == 0);
}

/* The focused peer is the background and the first input; the rest are
 * thumbnails along the bottom. That ordering is not cosmetic — the
 * filter graph names inputs by index and overlays onto input 0. */
TEST(the_focused_peer_is_the_background_and_the_rest_are_thumbnails) {
    struct media_tile t[MEDIA_MAX_PEERS];
    /* Deliberately NOT 0,1,2,3: the active set has holes in it — a peer
     * with the camera off is dropped from the mix — and a layout that
     * quietly assumed contiguous slots would draw the wrong people. */
    const int slots[4] = { 0, 2, 5, 7 };

    /* One peer fills the frame, whatever the frame is. */
    CHECK(media_tile_layout(slots, 1, 0, 640, 480, t, MEDIA_MAX_PEERS) == 1);
    CHECK(t[0].slot == 0 && t[0].x == 0 && t[0].y == 0 && t[0].w == 640 && t[0].h == 480);

    /* Three peers, the second focused: they lead, and the other two sit
     * along the bottom in order. `focus` indexes the LIST, and what
     * comes back is the real slot. */
    int n = media_tile_layout(slots, 3, 1, 640, 480, t, MEDIA_MAX_PEERS);
    CHECK(n == 3);
    CHECK(t[0].slot == 2 && t[0].w == 640 && t[0].h == 480);
    CHECK(t[1].slot == 0);
    CHECK(t[2].slot == 5);
    /* Thumbnails, side by side, inside the frame. */
    CHECK(t[1].w == 160 && t[1].h == 120);
    CHECK(t[2].x > t[1].x);
    CHECK(t[1].y + t[1].h <= 480);
    CHECK(t[2].x + t[2].w <= 640);

    /* Every dimension even: the frame is drawn as half blocks, two
     * pixel rows to a cell, so an odd height loses its bottom row. */
    n = media_tile_layout(slots, 4, 0, 641, 481, t, MEDIA_MAX_PEERS);
    for (int i = 0; i < n; i++) CHECK(t[i].w % 2 == 0 && t[i].h % 2 == 0);

    /* A picture-in-picture corner box has room for ONE person, and says
     * so by laying out one — rather than four tiles of ASCII confetti. */
    CHECK(media_tile_layout(slots, 4, 0, 40, 30, t, MEDIA_MAX_PEERS) == 1);

    /* A stale focus after somebody left is the wrong person's picture,
     * never a read past the end. */
    n = media_tile_layout(slots, 2, 9, 640, 480, t, MEDIA_MAX_PEERS);
    CHECK(n == 2 && t[0].slot == 0 && t[1].slot == 2);
    n = media_tile_layout(slots, 2, -1, 640, 480, t, MEDIA_MAX_PEERS);
    CHECK(n == 2 && t[0].slot == 0);

    CHECK(media_tile_layout(slots, 0, 0, 640, 480, t, MEDIA_MAX_PEERS) == 0);
    CHECK(media_tile_layout(slots, 2, 0, 0, 480, t, MEDIA_MAX_PEERS) == 0);
    CHECK(media_tile_layout(slots, 2, 0, 640, 480, NULL, MEDIA_MAX_PEERS) == 0);
    CHECK(media_tile_layout(NULL, 2, 0, 640, 480, t, MEDIA_MAX_PEERS) == 0);
}

/* A wrong label here is ffmpeg exiting on a parse error onto a
 * discarded stderr: a video call that shows nothing and says nothing. */
TEST(the_mix_filter_chains_every_tile_into_one_output) {
    struct media_tile t[MEDIA_MAX_PEERS];
    const int slots[4] = { 0, 2, 5, 7 };
    char f[4096];

    /* One input needs no overlay at all, but still has to produce the
     * label the caller maps. */
    CHECK(media_tile_layout(slots, 1, 0, 320, 240, t, MEDIA_MAX_PEERS) == 1);
    CHECK(media_mix_filter(t, 1, 10, f, sizeof(f)));
    CHECK(strstr(f, "[0:v]fps=10,") != NULL);
    CHECK(strstr(f, "[out]") != NULL);
    CHECK(strstr(f, "overlay") == NULL);

    /* Two: one overlay, straight to the output. */
    CHECK(media_tile_layout(slots, 2, 0, 640, 480, t, MEDIA_MAX_PEERS) == 2);
    CHECK(media_mix_filter(t, 2, 12, f, sizeof(f)));
    CHECK(strstr(f, "[t0][t1]overlay=") != NULL);
    CHECK(strstr(f, "eof_action=pass") != NULL);
    CHECK(strstr(f, "[out]") != NULL);
    /* No dangling intermediate link when the chain is one stage long. */
    CHECK(strstr(f, "[m1]") == NULL);

    /* Four: the chain must thread m1, m2 and end at [out] — the case
     * where an off-by-one leaves a link nothing reads and ffmpeg
     * refuses the whole graph. */
    CHECK(media_tile_layout(slots, 4, 0, 640, 480, t, MEDIA_MAX_PEERS) == 4);
    CHECK(media_mix_filter(t, 4, 10, f, sizeof(f)));
    CHECK(strstr(f, "[t0][t1]overlay=") != NULL);
    CHECK(strstr(f, "[m1][t2]overlay=") != NULL);
    CHECK(strstr(f, "[m2][t3]overlay=") != NULL);
    CHECK(strstr(f, "[m3]") == NULL);
    /* Exactly one output, and it is the last thing in the graph. */
    const char *out = strstr(f, "[out]");
    CHECK(out != NULL && strstr(out + 1, "[out]") == NULL);
    CHECK(strcmp(out, "[out]") == 0);
    /* Every input appears, each with its own scale-and-pad. */
    for (int i = 0; i < 4; i++) {
        /* Sized so any int provably fits: eleven digits plus the eight
         * literal bytes and the terminator. */
        char want[24];
        snprintf(want, sizeof(want), "[%d:v]fps=", i);
        CHECK(strstr(f, want) != NULL);
    }

    /* Refused rather than half-written: a truncated graph is ffmpeg
     * failing to parse, which reaches nobody. */
    char tiny[32];
    CHECK(!media_mix_filter(t, 4, 10, tiny, sizeof(tiny)));
    CHECK(!media_mix_filter(t, 0, 10, f, sizeof(f)));
    CHECK(!media_mix_filter(NULL, 2, 10, f, sizeof(f)));
}

/* Two legs must never be handed the same port, and the port has to be
 * one the caller can actually tell ffmpeg about. */
TEST(loopback_ports_are_distinct_and_reported) {
    int a = 0, b = 0;
    int fd_a = media_bind_loopback(&a);
    int fd_b = media_bind_loopback(&b);
    CHECK(fd_a >= 0);
    CHECK(fd_b >= 0);
    CHECK(a > 0);
    CHECK(b > 0);
    CHECK(a != b);
    if (fd_a >= 0) close(fd_a);
    if (fd_b >= 0) close(fd_b);
}

int main(void) {
    RUN(the_receive_sdp_describes_what_was_negotiated);
    RUN(the_receive_sdp_follows_the_negotiated_video_codec);
    RUN(the_video_codec_is_parsed_or_refused);
    RUN(the_focused_peer_is_the_background_and_the_rest_are_thumbnails);
    RUN(the_mix_filter_chains_every_tile_into_one_output);
    RUN(loopback_ports_are_distinct_and_reported);
    return test_report();
}
