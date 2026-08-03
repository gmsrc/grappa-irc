/* termcolor.h — RGB → terminal colour, and RGB → character art.
 *
 * Two consumers share this: the mIRC renderer (which must map a 99-colour
 * palette and arbitrary \x04 hex onto whatever the terminal has) and the
 * media preview (which draws a decoded frame when the terminal has no
 * graphics protocol). Both need the same quantisation, so it lives once.
 *
 * Pure — no ncurses, no terminal state — so the quantiser and the art
 * renderer can be tested without a TTY.
 */
#ifndef SHOTTINO_TERMCOLOR_H
#define SHOTTINO_TERMCOLOR_H

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>

/* What the terminal can actually show. Probed from the environment by
 * `termcolor_detect_depth`; callers may override. */
typedef enum {
    TERM_COLOR_NONE,
    TERM_COLOR_8,
    TERM_COLOR_256,
    TERM_COLOR_TRUE
} term_color_depth;

/* Nearest xterm-256 index (16-255) for 0xRRGGBB. Uses the 6x6x6 cube or
 * the 24-step grey ramp, whichever is closer — near-neutral colours go to
 * the ramp because the cube's grey axis is coarse enough to visibly tint
 * them. */
int termcolor_xterm256(long rgb);

/* Nearest of the basic 8 (as a curses/ANSI colour number 0-7). */
int termcolor_basic8(long rgb);

/* A luminance ramp glyph, for a terminal with no usable colour. */
char termcolor_ramp_char(int r, int g, int b);

/* Probe COLORTERM / TERM. Never returns TERM_COLOR_TRUE on a guess: it
 * requires an explicit truecolor advertisement, because emitting 24-bit
 * escapes at a terminal that cannot parse them prints visible garbage. */
term_color_depth termcolor_detect_depth(void);

/* True when the terminal advertises a bitmap graphics protocol (Kitty,
 * iTerm2, Sixel, WezTerm). Absence is NOT a reason to refuse a preview —
 * it selects character-art rendering instead. */
bool termcolor_has_graphics(void);

/* Render a raw RGB24 buffer (`w` x `h`, 3 bytes per pixel, row-major) to
 * `out` as character art.
 *
 * Two vertically-adjacent pixels share one cell: the upper-half-block
 * glyph is drawn in the top pixel's colour over the bottom pixel's
 * colour, which doubles vertical resolution and is why the result reads
 * as a picture rather than as ASCII art. Below 256 colours it degrades to
 * one averaged cell with a ramp glyph, since two indistinguishable blocks
 * would carry no shape information.
 *
 * Rows are terminated with CRLF (the terminal is in raw mode when this
 * runs) and the SGR state is reset at the end of every row, so a torn
 * render cannot leak colour into the rest of the screen.
 */
void termcolor_render_rgb(const unsigned char *rgb, int w, int h, term_color_depth depth,
                          FILE *out);


/* Perceived brightness of an RGB triple, 0-255 (Rec.601 weights — the
 * same ones the art ramp uses, because "how bright is this" has one
 * answer in this codebase). */
int termcolor_luminance(long rgb);

/* Lift (or sink) `rgb` until it is readable against a background of
 * brightness `bg_lum`, preserving hue.
 *
 * A bot that writes dark blue on a terminal whose background is black
 * has posted text nobody can read — mIRC colours were chosen against
 * mIRC's own white background, and nothing carries that assumption
 * across. `min_delta` is the brightness separation demanded; the colour
 * is scaled toward white (on a dark background) or toward black (on a
 * light one) until it clears, so the hue survives and only the
 * readability changes.
 *
 * Returns `rgb` unchanged when it already clears the floor, and for a
 * negative (inherit) input. Pure — no terminal, no globals. */
long termcolor_readable(long rgb, int bg_lum, int min_delta);

#endif /* SHOTTINO_TERMCOLOR_H */
