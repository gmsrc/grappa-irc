/* termcolor.c — see termcolor.h. */
#include "termcolor.h"

#include <stdlib.h>
#include <string.h>
#include <strings.h>

int termcolor_xterm256(long rgb) {
    if (rgb < 0) return -1;
    int r = (int)((rgb >> 16) & 0xff), g = (int)((rgb >> 8) & 0xff), b = (int)(rgb & 0xff);
    int max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    int min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    /* Near-neutral goes to the grey ramp: the cube's grey axis has only
     * six steps and visibly tints greys toward whichever channel rounds
     * up. */
    if (max - min < 16) {
        int level = (r + g + b) / 3;
        if (level < 8) return 16;    /* cube black */
        if (level > 238) return 231; /* cube white */
        return 232 + (level - 8) / 10;
    }
    int qr = (r * 5 + 127) / 255, qg = (g * 5 + 127) / 255, qb = (b * 5 + 127) / 255;
    return 16 + 36 * qr + 6 * qg + qb;
}

int termcolor_basic8(long rgb) {
    if (rgb < 0) return -1;
    int r = (int)((rgb >> 16) & 0xff), g = (int)((rgb >> 8) & 0xff), b = (int)(rgb & 0xff);
    /* ANSI order is black, red, green, yellow, blue, magenta, cyan,
     * white — i.e. bit 0 red, bit 1 green, bit 2 blue. */
    return (r > 127 ? 1 : 0) | (g > 127 ? 2 : 0) | (b > 127 ? 4 : 0);
}

char termcolor_ramp_char(int r, int g, int b) {
    static const char ramp[] = " .:-=+*#%@";
    int lum = (r * 30 + g * 59 + b * 11) / 100; /* 0..255, Rec.601 weights */
    if (lum < 0) lum = 0;
    if (lum > 255) lum = 255;
    int idx = lum * (int)(sizeof(ramp) - 2) / 255;
    return ramp[idx];
}

static bool env_contains(const char *name, const char *needle) {
    const char *v = getenv(name);
    if (!v) return false;
    /* Case-insensitive substring without strcasestr, which is a GNU/BSD
     * extension and not guaranteed by C11. */
    size_t nlen = strlen(needle);
    if (nlen == 0) return true;
    for (const char *p = v; *p; p++)
        if (strncasecmp(p, needle, nlen) == 0) return true;
    return false;
}

term_color_depth termcolor_detect_depth(void) {
    /* Truecolor requires an explicit advertisement. Guessing it and being
     * wrong prints raw escape sequences as visible garbage, which is a
     * far worse failure than rendering in 256 colours. */
    if (env_contains("COLORTERM", "truecolor") || env_contains("COLORTERM", "24bit"))
        return TERM_COLOR_TRUE;
    if (env_contains("TERM", "256color") || env_contains("TERM", "direct")) return TERM_COLOR_256;
    const char *term = getenv("TERM");
    if (!term || !*term || strcmp(term, "dumb") == 0) return TERM_COLOR_NONE;
    return TERM_COLOR_8;
}

bool termcolor_has_graphics(void) {
    if (getenv("KITTY_WINDOW_ID") || env_contains("TERM", "kitty")) return true;
    if (env_contains("TERM_PROGRAM", "iTerm")) return true;
    if (getenv("WEZTERM_PANE") || env_contains("TERM_PROGRAM", "WezTerm")) return true;
    if (env_contains("TERM", "sixel") || env_contains("TERM", "mlterm")) return true;
    /* Sixel support is not reliably detectable without querying the
     * terminal, so allow an explicit opt-in. */
    if (getenv("SHOTTINO_GRAPHICS")) return true;
    return false;
}

void termcolor_render_rgb(const unsigned char *rgb, int w, int h, term_color_depth depth,
                          FILE *out) {
    if (!rgb || !out || w <= 0 || h <= 1) return;
    for (int y = 0; y + 1 < h; y += 2) {
        for (int x = 0; x < w; x++) {
            const unsigned char *top = rgb + ((size_t)y * (size_t)w + (size_t)x) * 3;
            const unsigned char *bot = rgb + ((size_t)(y + 1) * (size_t)w + (size_t)x) * 3;
            switch (depth) {
            case TERM_COLOR_TRUE:
                fprintf(out, "\033[38;2;%d;%d;%dm\033[48;2;%d;%d;%dm▀", top[0], top[1],
                        top[2], bot[0], bot[1], bot[2]);
                break;
            case TERM_COLOR_256: {
                long tv = ((long)top[0] << 16) | ((long)top[1] << 8) | top[2];
                long bv = ((long)bot[0] << 16) | ((long)bot[1] << 8) | bot[2];
                fprintf(out, "\033[38;5;%dm\033[48;5;%dm▀", termcolor_xterm256(tv),
                        termcolor_xterm256(bv));
                break;
            }
            case TERM_COLOR_8: {
                /* With 8 colours a half block would usually show two
                 * indistinguishable blocks and carry no shape; one
                 * averaged cell with a ramp glyph carries both. */
                int r = (top[0] + bot[0]) / 2, g = (top[1] + bot[1]) / 2,
                    b = (top[2] + bot[2]) / 2;
                long avg = ((long)r << 16) | ((long)g << 8) | b;
                fprintf(out, "\033[%dm%c", 30 + termcolor_basic8(avg),
                        termcolor_ramp_char(r, g, b));
                break;
            }
            case TERM_COLOR_NONE: {
                int r = (top[0] + bot[0]) / 2, g = (top[1] + bot[1]) / 2,
                    b = (top[2] + bot[2]) / 2;
                fputc(termcolor_ramp_char(r, g, b), out);
                break;
            }
            }
        }
        /* Reset per row, and CRLF because the terminal is in raw mode
         * during a preview — a bare \n would stair-step the image. */
        fputs("\033[0m\r\n", out);
    }
}
