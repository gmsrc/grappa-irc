/* mirc.c — see mirc.h. Control-byte semantics deliberately match
 * cicchetto's lib/mircFormat.ts, including its lookahead rules, so the
 * two clients render the same bytes the same way. */
#include "mirc.h"

#include <stdlib.h>
#include <string.h>

/* mIRC 99-colour palette. 0-15 are the classic mIRC defaults; 16-98 are
 * the extended palette from modern.ircdocs.horse/formatting. Code 99 is
 * "default" (inherit surrounding style) and has no entry. Transcribed
 * mechanically from cicchetto's MIRC_PALETTE so the two cannot drift. */
static const long MIRC_PALETTE[99] = {
    0xffffff, 0x000000, 0x00007f, 0x009300, 0xff0000, 0x7f0000,
    0x9c009c, 0xfc7f00, 0xffff00, 0x00fc00, 0x009393, 0x00ffff,
    0x0000fc, 0xff00ff, 0x7f7f7f, 0xd2d2d2, 0x470000, 0x472100,
    0x474700, 0x324700, 0x004700, 0x00472c, 0x004747, 0x002747,
    0x000047, 0x2e0047, 0x470047, 0x47002a, 0x740000, 0x743a00,
    0x747400, 0x517400, 0x007400, 0x007449, 0x007474, 0x004074,
    0x000074, 0x4b0074, 0x740074, 0x740045, 0xb50000, 0xb56300,
    0xb5b500, 0x7db500, 0x00b500, 0x00b571, 0x00b5b5, 0x0063b5,
    0x0000b5, 0x7500b5, 0xb500b5, 0xb5006b, 0xff0000, 0xff8c00,
    0xffff00, 0xb2ff00, 0x00ff00, 0x00ffa0, 0x00ffff, 0x008cff,
    0x0000ff, 0xa500ff, 0xff00ff, 0xff0098, 0xff5959, 0xffb459,
    0xffff71, 0xcfff60, 0x6fff6f, 0x65ffc9, 0x6dffff, 0x59b4ff,
    0x5959ff, 0xc459ff, 0xff66ff, 0xff59bc, 0xff9c9c, 0xffd39c,
    0xffff9c, 0xe2ff9c, 0x9cff9c, 0x9cffdb, 0x9cffff, 0x9cd3ff,
    0x9c9cff, 0xdc9cff, 0xff9cff, 0xff94d3, 0x000000, 0x131313,
    0x282828, 0x363636, 0x4d4d4d, 0x656565, 0x818181, 0x9f9f9f,
    0xbcbcbc, 0xe2e2e2, 0xffffff,
};

long mirc_palette_rgb(int index) {
    if (index < 0 || index > 98) return -1; /* 99 = default, as does junk */
    return MIRC_PALETTE[index];
}

static bool is_digit(char c) { return c >= '0' && c <= '9'; }

static int hex_val(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Read exactly six hex digits at `p`. Returns the value or -1; a PARTIAL
 * run is a failure and consumes nothing, so its digits fall through as
 * plain text (mIRC behaviour, matching cic's readHex6). */
static long read_hex6(const char *p, size_t avail) {
    if (avail < 6) return -1;
    long v = 0;
    for (int i = 0; i < 6; i++) {
        int d = hex_val(p[i]);
        if (d < 0) return -1;
        v = (v << 4) | (long)d;
    }
    return v;
}

bool mirc_has_formatting(const char *body) {
    if (!body) return false;
    for (const char *p = body; *p; p++) {
        switch ((unsigned char)*p) {
        case 0x02: case 0x03: case 0x04: case 0x0f:
        case 0x11: case 0x16: case 0x1d: case 0x1e: case 0x1f:
            return true;
        default:
            break;
        }
    }
    return false;
}

struct state {
    bool bold, italic, underline, strikethrough, monospace, reverse;
    int fg, bg;
    bool fg_is_rgb, bg_is_rgb;
};

static const struct state INITIAL = {.fg = MIRC_COLOR_DEFAULT, .bg = MIRC_COLOR_DEFAULT};

size_t mirc_parse(const char *body, struct mirc_run *runs, size_t max_runs) {
    if (!body || !runs || max_runs == 0) return 0;
    struct state st = INITIAL;
    size_t n = 0;
    const char *start = body;
    const char *p = body;

    /* Close the run accumulated since `start`, if it has any text. */
    #define FLUSH()                                                                                \
        do {                                                                                       \
            if (p > start && n < max_runs) {                                                       \
                runs[n].text = start;                                                              \
                runs[n].len = (size_t)(p - start);                                                 \
                runs[n].bold = st.bold;                                                            \
                runs[n].italic = st.italic;                                                        \
                runs[n].underline = st.underline;                                                  \
                runs[n].strikethrough = st.strikethrough;                                          \
                runs[n].monospace = st.monospace;                                                  \
                runs[n].reverse = st.reverse;                                                      \
                runs[n].fg = st.fg;                                                                \
                runs[n].bg = st.bg;                                                                \
                runs[n].fg_is_rgb = st.fg_is_rgb;                                                  \
                runs[n].bg_is_rgb = st.bg_is_rgb;                                                  \
                n++;                                                                               \
            }                                                                                      \
            start = p;                                                                             \
        } while (0)

    while (*p) {
        /* Out of run slots: stop styling and let the tail ride as one
         * unstyled run. Dropping the text instead would silently eat the
         * message, which is worse than losing its colours. */
        if (n + 1 >= max_runs && (unsigned char)*p != '\0') {
            const char *tail = start;
            size_t tail_len = strlen(tail);
            if (tail_len && n < max_runs) {
                runs[n].text = tail;
                runs[n].len = tail_len;
                runs[n].bold = st.bold;
                runs[n].italic = st.italic;
                runs[n].underline = st.underline;
                runs[n].strikethrough = st.strikethrough;
                runs[n].monospace = st.monospace;
                runs[n].reverse = st.reverse;
                runs[n].fg = st.fg;
                runs[n].bg = st.bg;
                runs[n].fg_is_rgb = st.fg_is_rgb;
                runs[n].bg_is_rgb = st.bg_is_rgb;
                n++;
            }
            return n;
        }

        unsigned char c = (unsigned char)*p;
        switch (c) {
        case 0x02: FLUSH(); st.bold = !st.bold; p++; start = p; continue;
        case 0x1d: FLUSH(); st.italic = !st.italic; p++; start = p; continue;
        case 0x1f: FLUSH(); st.underline = !st.underline; p++; start = p; continue;
        case 0x1e: FLUSH(); st.strikethrough = !st.strikethrough; p++; start = p; continue;
        case 0x11: FLUSH(); st.monospace = !st.monospace; p++; start = p; continue;
        case 0x16: FLUSH(); st.reverse = !st.reverse; p++; start = p; continue;
        case 0x0f: FLUSH(); st = INITIAL; p++; start = p; continue;

        case 0x03: { /* palette colour */
            FLUSH();
            p++;
            char fg_str[3] = {0};
            size_t fg_len = 0;
            while (*p && fg_len < 2 && is_digit(*p)) fg_str[fg_len++] = *p++;

            char bg_str[3] = {0};
            size_t bg_len = 0;
            if (fg_len > 0 && *p == ',') {
                /* Only consume the comma if digits follow. A stray comma
                 * after a colour stays literal text — "\x034,foo" is red
                 * ",foo" because 'f' is not a digit. */
                const char *q = p + 1;
                char cand[3] = {0};
                size_t cand_len = 0;
                while (*q && cand_len < 2 && is_digit(*q)) cand[cand_len++] = *q++;
                if (cand_len > 0) {
                    memcpy(bg_str, cand, sizeof(bg_str));
                    bg_len = cand_len;
                    p = q;
                }
            }
            if (fg_len == 0) { /* bare \x03 resets both */
                st.fg = MIRC_COLOR_DEFAULT;
                st.bg = MIRC_COLOR_DEFAULT;
                st.fg_is_rgb = false;
                st.bg_is_rgb = false;
            } else {
                int fg = (int)strtol(fg_str, NULL, 10);
                st.fg = (fg >= 0 && fg <= 98) ? fg : MIRC_COLOR_DEFAULT;
                st.fg_is_rgb = false;
                if (bg_len > 0) {
                    int bg = (int)strtol(bg_str, NULL, 10);
                    st.bg = (bg >= 0 && bg <= 98) ? bg : MIRC_COLOR_DEFAULT;
                    st.bg_is_rgb = false;
                }
            }
            start = p;
            continue;
        }

        case 0x04: { /* literal hex colour */
            FLUSH();
            p++;
            long fg = read_hex6(p, strlen(p));
            if (fg < 0) {
                /* Bare or partial — reset. Partial digits are NOT consumed
                 * and fall through as plain text. */
                st.fg = MIRC_COLOR_DEFAULT;
                st.bg = MIRC_COLOR_DEFAULT;
                st.fg_is_rgb = false;
                st.bg_is_rgb = false;
                start = p;
                continue;
            }
            p += 6;
            st.fg = (int)fg;
            st.fg_is_rgb = true;
            if (*p == ',') {
                long bg = read_hex6(p + 1, strlen(p + 1));
                if (bg >= 0) {
                    st.bg = (int)bg;
                    st.bg_is_rgb = true;
                    p += 7;
                }
            }
            start = p;
            continue;
        }

        default:
            p++;
            break;
        }
    }
    FLUSH();
    #undef FLUSH
    return n;
}

size_t mirc_strip(const char *body, char *out, size_t out_sz) {
    if (!out || out_sz == 0) return 0;
    out[0] = '\0';
    if (!body) return 0;
    struct mirc_run runs[MIRC_MAX_RUNS];
    size_t n = mirc_parse(body, runs, MIRC_MAX_RUNS);
    size_t w = 0;
    for (size_t i = 0; i < n; i++) {
        size_t take = runs[i].len;
        if (w + take >= out_sz) take = out_sz - w - 1;
        memcpy(out + w, runs[i].text, take);
        w += take;
        if (w + 1 >= out_sz) break;
    }
    out[w] = '\0';
    return w;
}
