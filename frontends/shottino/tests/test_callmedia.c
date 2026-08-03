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

/* An EVEN grid, and — the property the whole design rests on — one
 * that does NOT depend on who is focused. If it did, every focus change
 * would rebuild the filter graph and restart the decoder, which is
 * measured in seconds because ffmpeg opens live RTP inputs
 * sequentially. Focus is a drawing decision at the other end; this only
 * has to say which pixels belong to whom. */
TEST(the_grid_is_even_and_independent_of_focus) {
    struct media_tile t[MEDIA_MAX_PEERS];
    /* Deliberately NOT 0,1,2,3: the live set has holes in it — a peer
     * with the camera off is dropped from the mix — and a layout that
     * quietly assumed contiguous slots would draw the wrong people. */
    const int slots[4] = { 0, 2, 5, 7 };

    /* One peer fills the frame. */
    CHECK(media_grid_layout(slots, 1, 640, 480, t, MEDIA_MAX_PEERS) == 1);
    CHECK(t[0].slot == 0 && t[0].x == 0 && t[0].y == 0 && t[0].w == 640 && t[0].h == 480);

    /* Two side by side, not stacked: a terminal cell is about twice as
     * tall as it is wide, and the pictures are landscape already. */
    CHECK(media_grid_layout(slots, 2, 640, 480, t, MEDIA_MAX_PEERS) == 2);
    CHECK(t[0].slot == 0 && t[1].slot == 2);
    CHECK(t[0].w == 320 && t[1].w == 320);
    CHECK(t[0].h == 480 && t[1].h == 480);
    CHECK(t[0].x == 0 && t[1].x == 320);
    CHECK(t[0].y == 0 && t[1].y == 0);

    /* Four in a 2x2, in slot order, tiling the frame exactly. */
    int n = media_grid_layout(slots, 4, 640, 480, t, MEDIA_MAX_PEERS);
    CHECK(n == 4);
    for (int i = 0; i < 4; i++) CHECK(t[i].slot == slots[i]);
    CHECK(t[0].x == 0 && t[0].y == 0);
    CHECK(t[1].x == 320 && t[1].y == 0);
    CHECK(t[2].x == 0 && t[2].y == 240);
    CHECK(t[3].x == 320 && t[3].y == 240);

    /* Cells never overlap and never leave the frame — the two ways a
     * grid can lie about which pixels are whose. */
    for (int i = 0; i < n; i++) {
        CHECK(t[i].x >= 0 && t[i].y >= 0);
        CHECK(t[i].x + t[i].w <= 640 && t[i].y + t[i].h <= 480);
        for (int j = i + 1; j < n; j++) {
            bool apart = t[i].x + t[i].w <= t[j].x || t[j].x + t[j].w <= t[i].x ||
                         t[i].y + t[i].h <= t[j].y || t[j].y + t[j].h <= t[i].y;
            CHECK(apart);
        }
    }

    /* Every dimension even: the frame is drawn as half blocks, two
     * pixel rows to a cell, so an odd height loses its bottom row. */
    n = media_grid_layout(slots, 3, 641, 481, t, MEDIA_MAX_PEERS);
    for (int i = 0; i < n; i++) CHECK(t[i].w % 2 == 0 && t[i].h % 2 == 0);

    /* Both sides of the floor, because "it degrades somehow" is not a
     * contract. A 40x30 frame splits four ways into 20x14 cells, which
     * clears the 16x12 minimum, so all four are laid out... */
    CHECK(media_grid_layout(slots, 4, 40, 30, t, MEDIA_MAX_PEERS) == 4);
    /* ...and a 30x20 frame does not: every arrangement of two or more
     * is below it, so it falls back to ONE picture rather than laying
     * out ASCII confetti. Reporting fewer than asked is how the caller
     * knows to say so instead of implying everybody is on screen. */
    CHECK(media_grid_layout(slots, 4, 30, 20, t, MEDIA_MAX_PEERS) == 1);
    CHECK(t[0].w == 30 && t[0].h == 20);

    CHECK(media_grid_layout(slots, 0, 640, 480, t, MEDIA_MAX_PEERS) == 0);
    CHECK(media_grid_layout(slots, 2, 0, 480, t, MEDIA_MAX_PEERS) == 0);
    CHECK(media_grid_layout(slots, 2, 640, 480, NULL, MEDIA_MAX_PEERS) == 0);
    CHECK(media_grid_layout(NULL, 2, 640, 480, t, MEDIA_MAX_PEERS) == 0);
}

/* A wrong label here is ffmpeg exiting on a parse error onto a
 * discarded stderr: a video call that shows nothing and says nothing. */
TEST(the_mix_filter_chains_every_tile_into_one_output) {
    struct media_tile t[MEDIA_MAX_PEERS];
    const int slots[4] = { 0, 2, 5, 7 };
    char f[4096];

    /* One input needs no overlay at all, but still has to produce the
     * label the caller maps. */
    CHECK(media_grid_layout(slots, 1, 320, 240, t, MEDIA_MAX_PEERS) == 1);
    CHECK(media_mix_filter(t, 1, 10, 640, 480, f, sizeof(f)));
    CHECK(strstr(f, "[0:v]fps=10,") != NULL);
    CHECK(strstr(f, "[out]") != NULL);
    CHECK(strstr(f, "overlay") == NULL);

    /* Two: one overlay, straight to the output. */
    CHECK(media_grid_layout(slots, 2, 640, 480, t, MEDIA_MAX_PEERS) == 2);
    CHECK(media_mix_filter(t, 2, 12, 640, 480, f, sizeof(f)));
    /* THE CANVAS. The first tile is padded out to the whole frame,
     * because the overlay chain composes onto it. Taking that tile as
     * the canvas unpadded only works when it covers the frame — true of
     * a focused-big layout, false of a grid — and the failure mode is
     * an output silently the size of ONE CELL with every other peer
     * clipped off the edge of it. Shipped exactly that for an hour. */
    CHECK(strstr(f, "pad=640:480:0:0") != NULL);
    CHECK(strstr(f, "[t0][t1]overlay=") != NULL);
    CHECK(strstr(f, "eof_action=pass") != NULL);
    CHECK(strstr(f, "[out]") != NULL);
    /* No dangling intermediate link when the chain is one stage long. */
    CHECK(strstr(f, "[m1]") == NULL);

    /* Four: the chain must thread m1, m2 and end at [out] — the case
     * where an off-by-one leaves a link nothing reads and ffmpeg
     * refuses the whole graph. */
    CHECK(media_grid_layout(slots, 4, 640, 480, t, MEDIA_MAX_PEERS) == 4);
    CHECK(media_mix_filter(t, 4, 10, 640, 480, f, sizeof(f)));
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
    CHECK(!media_mix_filter(t, 4, 10, 640, 480, tiny, sizeof(tiny)));
    CHECK(!media_mix_filter(t, 0, 10, 640, 480, f, sizeof(f)));
    CHECK(!media_mix_filter(NULL, 2, 10, 640, 480, f, sizeof(f)));
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
    RUN(the_grid_is_even_and_independent_of_focus);
    RUN(the_mix_filter_chains_every_tile_into_one_output);
    RUN(loopback_ports_are_distinct_and_reported);
    return test_report();
}
