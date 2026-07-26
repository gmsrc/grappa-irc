/* media.c — see media.h. */
#include "media.h"
#include "termcolor.h"

#include <errno.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <termios.h>
#include <unistd.h>

const char *media_protocol_name(media_protocol p) {
    switch (p) {
    case MEDIA_PROTO_KITTY: return "kitty";
    case MEDIA_PROTO_ITERM2: return "iterm2";
    case MEDIA_PROTO_SIXEL: return "sixel";
    case MEDIA_PROTO_NONE: return "none";
    }
    return "none";
}

static bool env_has(const char *name, const char *needle) {
    const char *v = getenv(name);
    if (!v) return false;
    size_t n = strlen(needle);
    for (const char *p = v; *p; p++)
        if (strncasecmp(p, needle, n) == 0) return true;
    return false;
}

media_protocol media_detect_env(void) {
    /* Kitty's own protocol first: where both are available it is the more
     * capable (placement control, deletion, no re-encode on scroll). */
    if (getenv("KITTY_WINDOW_ID") || env_has("TERM", "kitty")) return MEDIA_PROTO_KITTY;
    if (getenv("WEZTERM_PANE") || env_has("TERM_PROGRAM", "WezTerm")) return MEDIA_PROTO_KITTY;
    if (env_has("TERM_PROGRAM", "iTerm") || env_has("LC_TERMINAL", "iTerm")) return MEDIA_PROTO_ITERM2;
    if (env_has("TERM_PROGRAM", "ghostty") || env_has("TERM", "ghostty")) return MEDIA_PROTO_KITTY;
    /* Sixel is NOT guessed from $TERM: a terminal emulating a VT300 says
     * nothing about it there. It is probed instead — see media_detect. */
    return MEDIA_PROTO_NONE;
}

bool media_da1_has_sixel(const char *reply) {
    if (!reply) return false;
    /* A DA1 reply is `ESC [ ? 62 ; 1 ; 4 ; 6 c` — a semicolon-separated
     * capability list. Capability 4 is sixel. Scanning for the character
     * '4' would also match "64" and "14", so compare whole fields. */
    const char *p = strchr(reply, '?');
    if (!p) p = reply;
    else p++;
    while (*p) {
        const char *start = p;
        while (*p && *p != ';' && *p != 'c') p++;
        size_t len = (size_t)(p - start);
        if (len == 1 && start[0] == '4') return true;
        if (*p == 'c' || !*p) break;
        p++;
    }
    return false;
}

/* Ask the terminal what it is. Returns true when a reply was read. */
static bool da1_query(int fd, int timeout_ms, char *out, size_t out_sz) {
    if (!isatty(fd)) return false;
    struct termios saved, raw;
    if (tcgetattr(fd, &saved) != 0) return false;
    raw = saved;
    raw.c_lflag &= (tcflag_t) ~(ICANON | ECHO);
    raw.c_cc[VMIN] = 0;
    raw.c_cc[VTIME] = 0;
    if (tcsetattr(fd, TCSANOW, &raw) != 0) return false;

    bool got = false;
    if (write(fd, "\033[c", 3) == 3) {
        size_t n = 0;
        /* Read until the reply's terminating 'c' or the deadline. A
         * terminal that ignores DA1 simply costs us `timeout_ms`. */
        for (;;) {
            struct pollfd pfd = {.fd = fd, .events = POLLIN};
            int pr = poll(&pfd, 1, timeout_ms);
            if (pr <= 0) break;
            char ch;
            ssize_t r = read(fd, &ch, 1);
            if (r <= 0) break;
            if (n + 1 < out_sz) out[n++] = ch;
            if (ch == 'c') {
                got = true;
                break;
            }
        }
        out[n < out_sz ? n : out_sz - 1] = '\0';
    }
    tcsetattr(fd, TCSANOW, &saved);
    return got;
}

media_protocol media_detect(int fd, int timeout_ms) {
    const char *forced = getenv("SHOTTINO_GRAPHICS");
    if (forced && *forced) {
        if (strcasecmp(forced, "kitty") == 0) return MEDIA_PROTO_KITTY;
        if (strcasecmp(forced, "iterm2") == 0) return MEDIA_PROTO_ITERM2;
        if (strcasecmp(forced, "sixel") == 0) return MEDIA_PROTO_SIXEL;
        if (strcasecmp(forced, "none") == 0) return MEDIA_PROTO_NONE;
        /* Any other value is treated as "yes, something" — the historical
         * meaning of this variable before it took names. */
        return MEDIA_PROTO_SIXEL;
    }
    media_protocol p = media_detect_env();
    if (p != MEDIA_PROTO_NONE) return p;

    char reply[128] = "";
    if (da1_query(fd, timeout_ms, reply, sizeof(reply)) && media_da1_has_sixel(reply))
        return MEDIA_PROTO_SIXEL;
    return MEDIA_PROTO_NONE;
}

/* ── base64 (no OpenSSL dependency here; the encoders are tested pure) ── */

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static void b64_write(const unsigned char *in, size_t len, FILE *out) {
    size_t i = 0;
    for (; i + 2 < len; i += 3) {
        unsigned v = ((unsigned)in[i] << 16) | ((unsigned)in[i + 1] << 8) | in[i + 2];
        fputc(B64[(v >> 18) & 63], out);
        fputc(B64[(v >> 12) & 63], out);
        fputc(B64[(v >> 6) & 63], out);
        fputc(B64[v & 63], out);
    }
    if (i < len) {
        unsigned v = (unsigned)in[i] << 16;
        bool two = (i + 1 < len);
        if (two) v |= (unsigned)in[i + 1] << 8;
        fputc(B64[(v >> 18) & 63], out);
        fputc(B64[(v >> 12) & 63], out);
        fputc(two ? B64[(v >> 6) & 63] : '=', out);
        fputc('=', out);
    }
}

bool media_emit_iterm2(const unsigned char *img, size_t len, int cols, int rows, FILE *out) {
    if (!img || !len || !out || cols <= 0 || rows <= 0) return false;
    /* preserveAspectRatio=1 lets the terminal letterbox inside the cell
     * box rather than distorting; we have already fitted the box. */
    fprintf(out, "\033]1337;File=inline=1;size=%zu;width=%d;height=%d;preserveAspectRatio=1:",
            len, cols, rows);
    b64_write(img, len, out);
    fputs("\a", out);
    return true;
}

bool media_emit_kitty(const unsigned char *png, size_t len, int cols, int rows, FILE *out) {
    if (!png || !len || !out || cols <= 0 || rows <= 0) return false;
    /* The protocol requires the base64 payload be split into <=4096-byte
     * chunks, with m=1 on every chunk but the last. Sending it in one
     * blob works on some builds and silently truncates on others. */
    char *b64 = NULL;
    size_t b64_len = 0;
    FILE *mem = open_memstream(&b64, &b64_len);
    if (!mem) return false;
    b64_write(png, len, mem);
    fclose(mem);

    const size_t CHUNK = 4096;
    size_t off = 0;
    bool first = true;
    while (off < b64_len) {
        size_t take = b64_len - off < CHUNK ? b64_len - off : CHUNK;
        bool last = (off + take >= b64_len);
        if (first)
            fprintf(out, "\033_Ga=T,f=100,c=%d,r=%d,m=%d;", cols, rows, last ? 0 : 1);
        else
            fprintf(out, "\033_Gm=%d;", last ? 0 : 1);
        fwrite(b64 + off, 1, take, out);
        fputs("\033\\", out);
        off += take;
        first = false;
    }
    free(b64);
    return true;
}

/* ── Sixel ─────────────────────────────────────────────────────────────
 *
 * Sixel encodes six vertical pixels per character, one band at a time,
 * with a shared palette declared up front. A fixed 240-entry palette (the
 * xterm 6x6x6 cube plus the 24 greys, the same mapping termcolor uses)
 * avoids implementing median-cut and keeps the two renderers visually
 * consistent. Floyd–Steinberg dithering is what stops a photograph
 * banding at that palette size — without it skies and skin tones posterise
 * badly, which is most of why naive sixel output looks worse than the
 * same image in a browser. */

static void palette_rgb(int idx, int *r, int *g, int *b) {
    /* idx 0..215 = cube, 216..239 = greys; mirrors xterm 16..255. */
    if (idx < 216) {
        static const int level[6] = {0, 95, 135, 175, 215, 255};
        *r = level[(idx / 36) % 6];
        *g = level[(idx / 6) % 6];
        *b = level[idx % 6];
    } else {
        int v = 8 + (idx - 216) * 10;
        *r = *g = *b = v;
    }
}

static int nearest_palette(int r, int g, int b) {
    int idx = termcolor_xterm256(((long)r << 16) | ((long)g << 8) | b);
    /* termcolor returns an xterm index (16..255); our palette is 0-based
     * over the same range. */
    if (idx < 16) idx = 16;
    if (idx > 255) idx = 255;
    return idx - 16;
}

static int clamp255(int v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

bool media_emit_sixel(const unsigned char *rgb, int w, int h, FILE *out) {
    if (!rgb || !out || w <= 0 || h <= 0) return false;

    /* Dither into a palette-index buffer first, so the band encoder below
     * deals only with indices. Errors diffuse in a working copy of the
     * image so the caller's pixels are untouched. */
    int *work = malloc((size_t)w * (size_t)h * 3 * sizeof(int));
    unsigned char *idx = malloc((size_t)w * (size_t)h);
    if (!work || !idx) {
        free(work);
        free(idx);
        return false;
    }
    for (size_t i = 0; i < (size_t)w * (size_t)h * 3; i++) work[i] = rgb[i];

    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            size_t p = ((size_t)y * w + x) * 3;
            int r = clamp255(work[p]), g = clamp255(work[p + 1]), b = clamp255(work[p + 2]);
            int pi = nearest_palette(r, g, b);
            idx[(size_t)y * w + x] = (unsigned char)pi;
            int pr, pg, pb;
            palette_rgb(pi, &pr, &pg, &pb);
            int er = r - pr, eg = g - pg, eb = b - pb;
            /* Floyd–Steinberg: 7/16 right, 3/16 down-left, 5/16 down,
             * 1/16 down-right. */
            struct { int dx, dy, num; } spread[] = {{1, 0, 7}, {-1, 1, 3}, {0, 1, 5}, {1, 1, 1}};
            for (size_t k = 0; k < 4; k++) {
                int nx = x + spread[k].dx, ny = y + spread[k].dy;
                if (nx < 0 || nx >= w || ny >= h) continue;
                size_t np = ((size_t)ny * w + nx) * 3;
                work[np] += er * spread[k].num / 16;
                work[np + 1] += eg * spread[k].num / 16;
                work[np + 2] += eb * spread[k].num / 16;
            }
        }
    }
    free(work);

    /* Header: P1;0;0q selects 1:1 aspect and background-transparent off. */
    fputs("\033Pq", out);
    fprintf(out, "\"1;1;%d;%d", w, h);

    /* Declare only the colours actually used — a 240-entry preamble on a
     * small thumbnail is mostly waste. */
    bool used[240] = {false};
    for (size_t i = 0; i < (size_t)w * (size_t)h; i++) used[idx[i]] = true;
    for (int i = 0; i < 240; i++) {
        if (!used[i]) continue;
        int r, g, b;
        palette_rgb(i, &r, &g, &b);
        /* Sixel colour components are percentages, not 0-255. */
        fprintf(out, "#%d;2;%d;%d;%d", i, r * 100 / 255, g * 100 / 255, b * 100 / 255);
    }

    for (int top = 0; top < h; top += 6) {
        for (int c = 0; c < 240; c++) {
            if (!used[c]) continue;
            /* Does this colour appear anywhere in the band? Skipping the
             * empty ones is the difference between a compact sixel and one
             * that repeats an all-zero row 240 times per band. */
            bool present = false;
            for (int y = top; y < top + 6 && y < h && !present; y++)
                for (int x = 0; x < w; x++)
                    if (idx[(size_t)y * w + x] == c) {
                        present = true;
                        break;
                    }
            if (!present) continue;

            fprintf(out, "#%d", c);
            int run_char = -1, run_len = 0;
            for (int x = 0; x < w; x++) {
                int bits = 0;
                for (int y = top; y < top + 6 && y < h; y++)
                    if (idx[(size_t)y * w + x] == c) bits |= 1 << (y - top);
                int ch = 0x3F + bits;
                if (ch == run_char) {
                    run_len++;
                } else {
                    if (run_char >= 0) {
                        if (run_len > 3) fprintf(out, "!%d%c", run_len, run_char);
                        else for (int k = 0; k < run_len; k++) fputc(run_char, out);
                    }
                    run_char = ch;
                    run_len = 1;
                }
            }
            if (run_char >= 0) {
                if (run_len > 3) fprintf(out, "!%d%c", run_len, run_char);
                else for (int k = 0; k < run_len; k++) fputc(run_char, out);
            }
            fputc('$', out); /* carriage return within the band */
        }
        fputc('-', out); /* next band */
    }
    fputs("\033\\", out);
    free(idx);
    return true;
}

void media_fit_cells(int img_w, int img_h, int max_cols, int max_rows, int *cols, int *rows) {
    if (cols) *cols = 0;
    if (rows) *rows = 0;
    if (img_w <= 0 || img_h <= 0 || max_cols <= 0 || max_rows <= 0) return;
    /* A terminal cell is roughly twice as tall as it is wide, so a square
     * image needs twice as many columns as rows. Skipping this is why
     * naive terminal image output looks vertically stretched. */
    const double CELL_ASPECT = 2.0;
    double want_cols = (double)max_rows * ((double)img_w / (double)img_h) * CELL_ASPECT;
    int c, r;
    if (want_cols <= max_cols) {
        r = max_rows;
        c = (int)(want_cols + 0.5);
    } else {
        c = max_cols;
        r = (int)(((double)max_cols / ((double)img_w / (double)img_h) / CELL_ASPECT) + 0.5);
    }
    if (c < 1) c = 1;
    if (r < 1) r = 1;
    if (c > max_cols) c = max_cols;
    if (r > max_rows) r = max_rows;
    /* Both outputs are optional — a caller may want only one. The early
     * guards above already honour that; so must the success path. */
    if (cols) *cols = c;
    if (rows) *rows = r;
}
