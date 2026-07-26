/* test_mirc.c — mIRC formatting parser.
 *
 * The colour codes have lookahead rules that are easy to get subtly wrong
 * and that produce garbage on screen when you do: a stray comma after a
 * colour must stay literal text, a partial hex run must not be consumed,
 * and \x0310 is colour 10 rather than colour 1 followed by "0". Each is
 * pinned here against the behaviour cicchetto implements.
 *
 * Escapes are written in octal, not \x — a hex escape is greedy, so
 * "\x03" followed by a digit would lex as one wrong byte.
 */
#include "../mirc.h"
#include "test.h"

#include <stdlib.h>

#define BOLD "\002"
#define ITALIC "\035"
#define UNDER "\037"
#define STRIKE "\036"
#define MONO "\021"
#define REVERSE "\026"
#define RESET "\017"
#define COLOR "\003"
#define HEX "\004"

/* Assert a run's text span matches, since runs are not NUL-terminated. */
static void check_run_text(const struct mirc_run *r, const char *expect) {
    test_checks++;
    size_t elen = strlen(expect);
    if (r->len != elen || memcmp(r->text, expect, elen) != 0) {
        test_failures++;
        fprintf(stderr, "FAIL [%s] expected run \"%s\", got \"%.*s\"\n", test_current, expect,
                (int)r->len, r->text);
    }
}

TEST(plain_text_is_one_run) {
    struct mirc_run runs[MIRC_MAX_RUNS];
    size_t n = mirc_parse("hello world", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 1);
    check_run_text(&runs[0], "hello world");
    CHECK(!runs[0].bold);
    CHECK_LONG(runs[0].fg, MIRC_COLOR_DEFAULT);
    CHECK(!mirc_has_formatting("hello world"));
}

TEST(toggles) {
    struct mirc_run runs[MIRC_MAX_RUNS];
    size_t n = mirc_parse("a" BOLD "b" BOLD "c", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 3);
    check_run_text(&runs[0], "a");
    CHECK(!runs[0].bold);
    check_run_text(&runs[1], "b");
    CHECK(runs[1].bold);
    check_run_text(&runs[2], "c");
    CHECK(!runs[2].bold); /* toggled back off */

    /* Each attribute has its own toggle and they compose. */
    n = mirc_parse(BOLD ITALIC UNDER STRIKE MONO REVERSE "x", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 1);
    CHECK(runs[0].bold && runs[0].italic && runs[0].underline);
    CHECK(runs[0].strikethrough && runs[0].monospace && runs[0].reverse);
    CHECK(mirc_has_formatting(BOLD "x"));
}

TEST(reset_clears_everything) {
    struct mirc_run runs[MIRC_MAX_RUNS];
    size_t n = mirc_parse(BOLD COLOR "4" "red" RESET "plain", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 2);
    check_run_text(&runs[0], "red");
    CHECK(runs[0].bold);
    CHECK_LONG(runs[0].fg, 4);
    check_run_text(&runs[1], "plain");
    CHECK(!runs[1].bold);
    CHECK_LONG(runs[1].fg, MIRC_COLOR_DEFAULT);
}

TEST(palette_colors) {
    struct mirc_run runs[MIRC_MAX_RUNS];
    /* Single digit. */
    size_t n = mirc_parse(COLOR "4red", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 1);
    check_run_text(&runs[0], "red");
    CHECK_LONG(runs[0].fg, 4);
    CHECK(!runs[0].fg_is_rgb);

    /* Two digits — \x0310 is colour 10, NOT colour 1 then "0". */
    n = mirc_parse(COLOR "10cyan", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 1);
    check_run_text(&runs[0], "cyan");
    CHECK_LONG(runs[0].fg, 10);

    /* Digits stop at two: \x03123 is colour 12 followed by "3". */
    n = mirc_parse(COLOR "123", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 1);
    check_run_text(&runs[0], "3");
    CHECK_LONG(runs[0].fg, 12);

    /* Foreground and background. */
    n = mirc_parse(COLOR "4,8warn", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 1);
    check_run_text(&runs[0], "warn");
    CHECK_LONG(runs[0].fg, 4);
    CHECK_LONG(runs[0].bg, 8);

    /* Bare \x03 resets both. */
    n = mirc_parse(COLOR "4,8x" COLOR "y", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 2);
    CHECK_LONG(runs[1].fg, MIRC_COLOR_DEFAULT);
    CHECK_LONG(runs[1].bg, MIRC_COLOR_DEFAULT);

    /* 99 is "default", not a palette entry. */
    n = mirc_parse(COLOR "99x", runs, MIRC_MAX_RUNS);
    CHECK_LONG(runs[0].fg, MIRC_COLOR_DEFAULT);
}

/* The corner that breaks naive parsers: a comma NOT followed by digits is
 * literal text, so "\x034,foo" is red ",foo" — the comma stays. */
TEST(stray_comma_after_color_stays_literal) {
    struct mirc_run runs[MIRC_MAX_RUNS];
    size_t n = mirc_parse(COLOR "4,foo", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 1);
    check_run_text(&runs[0], ",foo");
    CHECK_LONG(runs[0].fg, 4);
    CHECK_LONG(runs[0].bg, MIRC_COLOR_DEFAULT);

    /* A comma with no colour digits before it is plain text throughout. */
    n = mirc_parse(COLOR ",4x", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 1);
    check_run_text(&runs[0], ",4x");
    CHECK_LONG(runs[0].fg, MIRC_COLOR_DEFAULT);
}

TEST(hex_colors) {
    struct mirc_run runs[MIRC_MAX_RUNS];
    size_t n = mirc_parse(HEX "ff0000red", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 1);
    check_run_text(&runs[0], "red");
    CHECK(runs[0].fg_is_rgb);
    CHECK_LONG(runs[0].fg, 0xff0000);

    /* fg,bg pair. */
    n = mirc_parse(HEX "ff0000,00ff00x", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 1);
    check_run_text(&runs[0], "x");
    CHECK_LONG(runs[0].fg, 0xff0000);
    CHECK(runs[0].bg_is_rgb);
    CHECK_LONG(runs[0].bg, 0x00ff00);

    /* Uppercase hex is accepted. */
    n = mirc_parse(HEX "ABCDEFx", runs, MIRC_MAX_RUNS);
    CHECK_LONG(runs[0].fg, 0xabcdef);

    /* A PARTIAL hex run is not consumed — it falls through as text, and
     * the colour resets. Consuming it would silently eat characters. */
    n = mirc_parse(HEX "ff00x", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 1);
    check_run_text(&runs[0], "ff00x");
    CHECK_LONG(runs[0].fg, MIRC_COLOR_DEFAULT);

    /* Bare \x04 resets. */
    n = mirc_parse(COLOR "4x" HEX "y", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 2);
    CHECK_LONG(runs[1].fg, MIRC_COLOR_DEFAULT);

    /* A trailing comma with no valid hex after it stays literal. */
    n = mirc_parse(HEX "ff0000,zz", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 1);
    check_run_text(&runs[0], ",zz");
    CHECK_LONG(runs[0].fg, 0xff0000);
    CHECK(!runs[0].bg_is_rgb);
}

/* CTCP framing is NOT formatting — round-trip fidelity for /me depends on
 * \001 surviving untouched. */
TEST(ctcp_is_plain_text) {
    struct mirc_run runs[MIRC_MAX_RUNS];
    size_t n = mirc_parse("\001ACTION waves\001", runs, MIRC_MAX_RUNS);
    CHECK_LONG(n, 1);
    check_run_text(&runs[0], "\001ACTION waves\001");
    CHECK(!mirc_has_formatting("\001ACTION waves\001"));

    char out[64];
    mirc_strip("\001ACTION waves\001", out, sizeof(out));
    CHECK_STR(out, "\001ACTION waves\001");
}

TEST(strip_removes_control_bytes_only) {
    char out[128];
    mirc_strip(BOLD "bold" RESET " and " COLOR "4red" COLOR " plain", out, sizeof(out));
    CHECK_STR(out, "bold and red plain");

    mirc_strip("no formatting here", out, sizeof(out));
    CHECK_STR(out, "no formatting here");

    mirc_strip(HEX "ff0000hex" RESET, out, sizeof(out));
    CHECK_STR(out, "hex");

    /* Truncation must stay in bounds and NUL-terminate. */
    char small[8];
    mirc_strip("aaaaaaaaaaaaaaaaaaaaaa", small, sizeof(small));
    CHECK(strlen(small) < sizeof(small));

    mirc_strip("", out, sizeof(out));
    CHECK_STR(out, "");
}

TEST(palette_lookup) {
    CHECK_LONG(mirc_palette_rgb(0), 0xffffff);
    CHECK_LONG(mirc_palette_rgb(1), 0x000000);
    CHECK_LONG(mirc_palette_rgb(4), 0xff0000);
    CHECK_LONG(mirc_palette_rgb(98), 0xffffff);
    /* 99 is "default" and has no entry; out-of-range is the same answer. */
    CHECK_LONG(mirc_palette_rgb(99), -1);
    CHECK_LONG(mirc_palette_rgb(-1), -1);
    CHECK_LONG(mirc_palette_rgb(1000), -1);
}

/* A control byte with no text after it must not emit an empty run. */
TEST(no_empty_runs) {
    struct mirc_run runs[MIRC_MAX_RUNS];
    CHECK_LONG(mirc_parse(BOLD, runs, MIRC_MAX_RUNS), 0);
    CHECK_LONG(mirc_parse(RESET RESET RESET, runs, MIRC_MAX_RUNS), 0);
    CHECK_LONG(mirc_parse(COLOR "4", runs, MIRC_MAX_RUNS), 0);
    CHECK_LONG(mirc_parse("", runs, MIRC_MAX_RUNS), 0);
    /* Adjacent toggles collapse rather than producing empty spans. */
    CHECK_LONG(mirc_parse(BOLD ITALIC "x", runs, MIRC_MAX_RUNS), 1);
}

/* Running out of run slots must not silently eat the message tail. */
TEST(run_overflow_keeps_text) {
    char body[2048] = "";
    for (int i = 0; i < 200; i++) strcat(body, BOLD "x");
    struct mirc_run runs[8];
    size_t n = mirc_parse(body, runs, 8);
    CHECK(n <= 8);
    CHECK(n > 0);
    /* The final run must carry the remaining text, not be dropped. */
    size_t total = 0;
    for (size_t i = 0; i < n; i++) total += runs[i].len;
    CHECK(total >= 190); /* every 'x' still accounted for */
}

TEST(null_safety) {
    struct mirc_run runs[4];
    CHECK_LONG(mirc_parse(NULL, runs, 4), 0);
    CHECK_LONG(mirc_parse("x", NULL, 4), 0);
    CHECK_LONG(mirc_parse("x", runs, 0), 0);
    CHECK(!mirc_has_formatting(NULL));
    char out[16];
    CHECK_LONG(mirc_strip(NULL, out, sizeof(out)), 0);
    CHECK_STR(out, "");
    CHECK_LONG(mirc_strip("x", NULL, 16), 0);
}

int main(void) {
    RUN(plain_text_is_one_run);
    RUN(toggles);
    RUN(reset_clears_everything);
    RUN(palette_colors);
    RUN(stray_comma_after_color_stays_literal);
    RUN(hex_colors);
    RUN(ctcp_is_plain_text);
    RUN(strip_removes_control_bytes_only);
    RUN(palette_lookup);
    RUN(no_empty_runs);
    RUN(run_overflow_keeps_text);
    RUN(null_safety);
    return test_report();
}
