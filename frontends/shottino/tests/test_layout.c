/* test_layout — the chat area's clipping contract.
 *
 * The one suite that does NOT link a leaf module: it compiles shottino.c
 * itself (with `main` renamed away) and drives the real drawing functions
 * against an offscreen ncurses screen, reading the result back out of the
 * virtual screen with mvinch(). No TTY is involved — newterm() renders to
 * /dev/null and the assertions read stdscr, which is pure memory.
 *
 * It exists because every layout bug in this client has been ONE bug: the
 * measuring pass and the draw pass disagreeing about how many rows
 * something occupies, always paid for by the newest message at the bottom
 * of the region. The property asserted here is the one that makes partial
 * scrolling safe — drawing a row from its `skip`-th display line must
 * produce exactly what a full draw puts on those same lines. Anything
 * else means the row reflows as it scrolls off, and the height the
 * measuring pass computed stops describing what is drawn.
 *
 * shottino.c has no other test target: the socket, the event dispatch and
 * the app state need a live server. Keep this suite to functions that are
 * pure given a screen. */
#define main shottino_main_unused
#include "../shottino.c"
#undef main

#include "test.h"

enum { MAX_W = 120, MAX_H = 64 };

static char full_rows[MAX_H][MAX_W + 1];
static char part_rows[MAX_H][MAX_W + 1];

static void snap(char dst[MAX_H][MAX_W + 1], int rows, int cols) {
    for (int y = 0; y < rows && y < MAX_H; y++) {
        for (int x = 0; x < cols && x < MAX_W; x++) dst[y][x] = (char)(mvinch(y, x) & A_CHARTEXT);
        dst[y][cols < MAX_W ? cols : MAX_W] = '\0';
    }
}

/* The tail of a wrapped body, drawn from line `skip`, is the full draw's
 * lines `skip`.. — same break points, same cells. */
static void check_text_tail(const char *s, int width, int height, int skip) {
    erase();
    draw_wrapped_text(0, 0, width, 0, height, CP_MAIN, 0, s);
    snap(full_rows, height, width);
    erase();
    draw_wrapped_text(0, 0, width, skip, height - skip, CP_MAIN, 0, s);
    snap(part_rows, height - skip, width);
    for (int y = 0; y + skip < height; y++) CHECK_STR(part_rows[y], full_rows[y + skip]);
}

/* Same for a whole log row, which additionally owns a timestamp and
 * `<nick>` on its FIRST line only: a tail must reproduce the continuation
 * lines, header and all, exactly where the full draw put them. */
static void check_msg_tail(const char *line, int width, int height, int skip) {
    erase();
    draw_message_line(0, 0, width, 0, height, line, false, false);
    snap(full_rows, height, width);
    erase();
    draw_message_line(0, 0, width, skip, height - skip, line, false, false);
    snap(part_rows, height - skip, width);
    for (int y = 0; y + skip < height; y++) CHECK_STR(part_rows[y], full_rows[y + skip]);
}

static const char *const BODIES[] = {
    "the quick brown fox jumps over the lazy dog and keeps going well past the wrap "
    "point so that this body occupies a good handful of display lines",
    /* mIRC formatting: the run walker must be walked from the start even
     * when its early runs land on skipped lines, or the tail loses the
     * colour it inherits. */
    "\x02" "bold start\x0F plain then \x03" "04,08coloured text that wraps across more "
    "than one display line to exercise the run walker end to end",
    /* Embedded newlines break lines without filling the width. */
    "first line\nsecond line that is long enough to wrap on its own once or twice\nthird",
    "\xc3\xa8 accented bytes \xc3\xa0 \xc3\xb9 repeated until this wraps a few times over "
    "so the byte-wise wrap is exercised too",
};

TEST(wrapped_text_tail_matches_full_draw) {
    for (size_t b = 0; b < sizeof(BODIES) / sizeof(BODIES[0]); b++) {
        for (int width = 12; width <= 40; width += 7) {
            int h = wrapped_text_lines_visible(BODIES[b], width);
            if (h > MAX_H) h = MAX_H;
            for (int skip = 0; skip < h; skip++) check_text_tail(BODIES[b], width, h, skip);
        }
    }
}

TEST(message_line_tail_matches_full_draw) {
    static const char *const LINES[] = {
        "[azzurra/#chan] 12:34 <someone> a message long enough to wrap over several "
        "lines in a narrow pane, which is the whole point of this check",
        "[azzurra/#chan] 12:34 --> someone has joined",
        "[azzurra/#chan] 12:34 <someone> https://example.net/a/very/long/link/that/wraps/"
        "around/the/pane/edge/more/than/once/for/sure.png",
    };
    for (size_t l = 0; l < sizeof(LINES) / sizeof(LINES[0]); l++) {
        for (int width = 30; width <= 60; width += 10) {
            int h = message_display_lines(LINES[l], width);
            if (h > MAX_H) h = MAX_H;
            for (int skip = 0; skip < h; skip++) check_msg_tail(LINES[l], width, h, skip);
        }
    }
}

/* A skip of zero must leave the ordinary path byte-identical — the
 * parameter is a clip, not a reflow. */
TEST(zero_skip_is_the_ordinary_draw) {
    const char *line = "[azzurra/#chan] 12:34 <someone> plain and short";
    erase();
    draw_message_line(0, 0, 60, 0, 3, line, false, false);
    snap(full_rows, 3, 60);
    CHECK(strstr(full_rows[0], "<someone>") != NULL);
    CHECK(strstr(full_rows[0], "plain and short") != NULL);
}

/* The header belongs to the row's first line; a tail must not repeat it. */
TEST(tail_omits_the_nick_header) {
    const char *line = "[azzurra/#chan] 12:34 <someone> a message long enough to wrap over "
                       "several lines in a narrow pane so a tail exists at all";
    int h = message_display_lines(line, 40);
    CHECK(h > 1);
    erase();
    draw_message_line(0, 0, 40, 1, h - 1, line, false, false);
    snap(part_rows, h - 1, 40);
    CHECK(strstr(part_rows[0], "<someone>") == NULL);
    CHECK(strstr(part_rows[0], "12:34") == NULL);
}

int main(void) {
    FILE *sink = fopen("/dev/null", "w");
    if (!sink) {
        fprintf(stderr, "test_layout: cannot open /dev/null — skipping\n");
        return 0;
    }
    /* An offscreen screen: no TTY, no terminfo beyond the entry named
     * here. A build host without terminfo skips rather than fails — the
     * suite asserts shottino's layout, not the host's terminal database. */
    if (!newterm("xterm", sink, stdin)) {
        fprintf(stderr, "test_layout: no usable terminfo entry — skipping\n");
        fclose(sink);
        return 0;
    }
    RUN(wrapped_text_tail_matches_full_draw);
    RUN(message_line_tail_matches_full_draw);
    RUN(zero_skip_is_the_ordinary_draw);
    RUN(tail_omits_the_nick_header);
    endwin();
    fclose(sink);
    return test_report();
}
