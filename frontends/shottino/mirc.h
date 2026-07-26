/* mirc.h — mIRC text-formatting parser.
 *
 * IRC has no markup standard; mIRC's de-facto control set is what clients
 * and IRCds actually implement. Shottino previously rendered none of it,
 * so a formatted message showed its control bytes as terminal garbage —
 * and worse, a `\x03` followed by digits ate the digits visually while
 * leaving the escape byte in the buffer.
 *
 *   \x02  bold          \x1d  italic        \x1f  underline
 *   \x1e  strikethrough \x11  monospace     \x16  reverse (swap fg/bg)
 *   \x03[fg[,bg]]       palette colour (0-98; 99 = default), bare = reset
 *   \x04[RRGGBB[,RRGGBB]]  literal hex colour, bare/partial = reset
 *   \x0f  reset everything
 *
 * CTCP framing (\x01) is NOT a formatting character. It is preserved
 * verbatim per the project's wire-format rule and treated as plain text
 * here on the off chance it appears mid-body.
 *
 * The parser emits a flat run list; each run carries the full attribute
 * state for its span of text. Runs BORROW from the input string — they
 * are valid as long as it is, and nothing here allocates.
 *
 * Colour is left as a palette index or a literal RGB rather than resolved
 * to a terminal colour here. The terminal's actual capability (truecolor
 * / 256 / 8) is a render-layer concern, and this module stays pure so it
 * can be tested without a TTY.
 */
#ifndef SHOTTINO_MIRC_H
#define SHOTTINO_MIRC_H

#include <stdbool.h>
#include <stddef.h>

#define MIRC_MAX_RUNS 128
#define MIRC_COLOR_DEFAULT (-1)

struct mirc_run {
    const char *text; /* borrowed; NOT NUL-terminated — use `len` */
    size_t len;
    bool bold;
    bool italic;
    bool underline;
    bool strikethrough;
    bool monospace;
    bool reverse;
    /* MIRC_COLOR_DEFAULT, a palette index 0-98, or a literal 0xRRGGBB
     * when the matching `_is_rgb` flag is set. */
    int fg;
    int bg;
    bool fg_is_rgb;
    bool bg_is_rgb;
};

/* Parse `body` into at most `max_runs` runs. Returns the number written.
 * Text beyond `max_runs` is not dropped: the final run absorbs the
 * remainder unstyled, so a pathological body still renders its words. */
size_t mirc_parse(const char *body, struct mirc_run *runs, size_t max_runs);

/* The visible text with every control byte removed. Derived from the same
 * parser as the styled render, so there is no second, drifting stripper. */
size_t mirc_strip(const char *body, char *out, size_t out_sz);

/* True when `body` contains any formatting control byte — lets the caller
 * skip the run machinery for the overwhelmingly common plain message. */
bool mirc_has_formatting(const char *body);

/* 0xRRGGBB for palette index 0-98; -1 for 99 (default) or out of range. */
long mirc_palette_rgb(int index);

#endif /* SHOTTINO_MIRC_H */
