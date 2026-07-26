/* test_media.c — protocol detection and the terminal-graphics encoders.
 *
 * The encoders write escape sequences a terminal parses; a byte wrong is
 * a garbled screen or a silently dropped image, so the framing is pinned
 * here rather than eyeballed.
 */
#include "../media.h"
#include "test.h"

#include <limits.h>
#include <stdlib.h>

static char *emit(bool (*fn)(const unsigned char *, size_t, int, int, FILE *),
                  const unsigned char *data, size_t len, int cols, int rows, size_t *out_len) {
    char *buf = NULL;
    size_t n = 0;
    FILE *f = open_memstream(&buf, &n);
    bool ok = fn(data, len, cols, rows, f);
    fclose(f);
    if (!ok) {
        free(buf);
        return NULL;
    }
    if (out_len) *out_len = n;
    return buf;
}

/* Capability 4 means sixel. The trap: scanning for the CHARACTER '4'
 * also matches "64" (a VT420 model number) and "14", so a naive check
 * reports sixel on terminals that have none. */
TEST(da1_sixel_parsing) {
    CHECK(media_da1_has_sixel("\033[?62;1;4;6c"));
    CHECK(media_da1_has_sixel("\033[?63;1;2;4;6;9;15;22c"));
    CHECK(media_da1_has_sixel("\033[?4c"));

    /* No capability 4 anywhere — but digits '4' appear inside 64 and 14. */
    CHECK(!media_da1_has_sixel("\033[?64;1;6;9;15;22c"));
    CHECK(!media_da1_has_sixel("\033[?62;14;21c"));
    CHECK(!media_da1_has_sixel("\033[?1;2c"));
    CHECK(!media_da1_has_sixel("\033[?62;40c"));
    CHECK(!media_da1_has_sixel(""));
    CHECK(!media_da1_has_sixel(NULL));
}

TEST(env_detection) {
    unsetenv("KITTY_WINDOW_ID");
    unsetenv("WEZTERM_PANE");
    unsetenv("TERM_PROGRAM");
    unsetenv("LC_TERMINAL");
    unsetenv("SHOTTINO_GRAPHICS");
    setenv("TERM", "xterm-256color", 1);
    /* Sixel is NEVER claimed from the environment — it needs the probe. */
    CHECK(media_detect_env() == MEDIA_PROTO_NONE);

    setenv("KITTY_WINDOW_ID", "1", 1);
    CHECK(media_detect_env() == MEDIA_PROTO_KITTY);
    unsetenv("KITTY_WINDOW_ID");

    setenv("TERM", "xterm-kitty", 1);
    CHECK(media_detect_env() == MEDIA_PROTO_KITTY);
    setenv("TERM", "xterm-256color", 1);

    setenv("TERM_PROGRAM", "iTerm.app", 1);
    CHECK(media_detect_env() == MEDIA_PROTO_ITERM2);
    unsetenv("TERM_PROGRAM");

    setenv("LC_TERMINAL", "iTerm2", 1);
    CHECK(media_detect_env() == MEDIA_PROTO_ITERM2);
    unsetenv("LC_TERMINAL");

    /* WezTerm speaks the kitty protocol, which we prefer where both are
     * available. */
    setenv("WEZTERM_PANE", "0", 1);
    CHECK(media_detect_env() == MEDIA_PROTO_KITTY);
    unsetenv("WEZTERM_PANE");
}

/* The override exists for terminals that lie or cannot be probed. It must
 * win over everything, including a contradicting environment. */
TEST(forced_protocol_overrides) {
    setenv("KITTY_WINDOW_ID", "1", 1);
    setenv("SHOTTINO_GRAPHICS", "sixel", 1);
    CHECK(media_detect(-1, 0) == MEDIA_PROTO_SIXEL);
    setenv("SHOTTINO_GRAPHICS", "none", 1);
    CHECK(media_detect(-1, 0) == MEDIA_PROTO_NONE);
    setenv("SHOTTINO_GRAPHICS", "iterm2", 1);
    CHECK(media_detect(-1, 0) == MEDIA_PROTO_ITERM2);
    setenv("SHOTTINO_GRAPHICS", "KITTY", 1); /* case-insensitive */
    CHECK(media_detect(-1, 0) == MEDIA_PROTO_KITTY);
    unsetenv("SHOTTINO_GRAPHICS");
    unsetenv("KITTY_WINDOW_ID");

    CHECK_STR(media_protocol_name(MEDIA_PROTO_SIXEL), "sixel");
    CHECK_STR(media_protocol_name(MEDIA_PROTO_KITTY), "kitty");
    CHECK_STR(media_protocol_name(MEDIA_PROTO_ITERM2), "iterm2");
    CHECK_STR(media_protocol_name(MEDIA_PROTO_NONE), "none");
}

/* A non-tty fd must not hang or crash the probe. */
TEST(detect_on_non_tty_is_safe) {
    unsetenv("SHOTTINO_GRAPHICS");
    unsetenv("KITTY_WINDOW_ID");
    unsetenv("WEZTERM_PANE");
    unsetenv("TERM_PROGRAM");
    unsetenv("LC_TERMINAL");
    setenv("TERM", "xterm-256color", 1);
    CHECK(media_detect(-1, 10) == MEDIA_PROTO_NONE);
    /* /dev/null is a valid fd but not a tty. */
    FILE *devnull = fopen("/dev/null", "r+");
    CHECK(devnull != NULL);
    if (devnull) {
        CHECK(media_detect(fileno(devnull), 10) == MEDIA_PROTO_NONE);
        fclose(devnull);
    }
}

TEST(iterm2_framing) {
    const unsigned char png[] = {0x89, 'P', 'N', 'G', 0x0d, 0x0a};
    size_t n = 0;
    char *o = emit(media_emit_iterm2, png, sizeof(png), 20, 10, &n);
    CHECK(o != NULL);
    if (!o) return;
    CHECK(strncmp(o, "\033]1337;File=inline=1;", 21) == 0);
    CHECK(strstr(o, "size=6;") != NULL);
    CHECK(strstr(o, "width=20;") != NULL);
    CHECK(strstr(o, "height=10;") != NULL);
    CHECK(strstr(o, "preserveAspectRatio=1:") != NULL);
    CHECK(o[n - 1] == '\a'); /* BEL terminator */
    free(o);

    CHECK(emit(media_emit_iterm2, png, sizeof(png), 0, 10, NULL) == NULL);
    CHECK(emit(media_emit_iterm2, NULL, 0, 20, 10, NULL) == NULL);
}

/* The kitty protocol REQUIRES <=4096-byte payload chunks with m=1 on all
 * but the last. One oversized blob works on some builds and truncates on
 * others, which is the kind of bug that only shows on someone else's
 * terminal. */
TEST(kitty_chunking) {
    size_t big = 9000; /* base64 expands this well past two chunks */
    unsigned char *png = malloc(big);
    for (size_t i = 0; i < big; i++) png[i] = (unsigned char)(i & 0xff);
    size_t n = 0;
    char *o = emit(media_emit_kitty, png, big, 40, 20, &n);
    CHECK(o != NULL);
    if (o) {
        CHECK(strncmp(o, "\033_Ga=T,f=100,c=40,r=20,m=1;", 27) == 0);
        int chunks = 0;
        for (const char *p = o; (p = strstr(p, "\033_G")); p++) chunks++;
        /* 9000 raw -> 12000 base64 -> ceil(12000/4096) = 3 chunks. */
        CHECK(chunks == 3);
        CHECK(strstr(o, "\033_Gm=0;") != NULL); /* a final chunk exists */
        CHECK(strstr(o, "\033\\") != NULL);     /* ST terminated */
        free(o);
    }
    free(png);

    /* A payload under one chunk is a single non-continued escape. */
    const unsigned char small[] = {1, 2, 3};
    o = emit(media_emit_kitty, small, sizeof(small), 4, 2, &n);
    CHECK(o != NULL);
    if (o) {
        CHECK(strstr(o, "m=0;") != NULL);
        CHECK(strstr(o, "m=1;") == NULL);
        free(o);
    }
}

static char *emit_sixel(const unsigned char *rgb, int w, int h, size_t *n) {
    char *buf = NULL;
    size_t len = 0;
    FILE *f = open_memstream(&buf, &len);
    bool ok = media_emit_sixel(rgb, w, h, f);
    fclose(f);
    if (!ok) {
        free(buf);
        return NULL;
    }
    if (n) *n = len;
    return buf;
}

TEST(sixel_framing) {
    /* A 4x6 solid red block: one band, one colour. */
    int w = 4, h = 6;
    unsigned char *rgb = malloc((size_t)w * h * 3);
    for (int i = 0; i < w * h; i++) {
        rgb[i * 3] = 255;
        rgb[i * 3 + 1] = 0;
        rgb[i * 3 + 2] = 0;
    }
    size_t n = 0;
    char *o = emit_sixel(rgb, w, h, &n);
    CHECK(o != NULL);
    if (o) {
        CHECK(strncmp(o, "\033Pq", 3) == 0);              /* DCS + sixel */
        CHECK(strstr(o, "\"1;1;4;6") != NULL);            /* raster attrs */
        CHECK(strstr(o, "#") != NULL);                    /* palette decl */
        CHECK(strstr(o, ";2;") != NULL);                  /* RGB colour form */
        CHECK(o[n - 2] == '\033' && o[n - 1] == '\\');    /* ST terminated */
        CHECK(strchr(o, '-') != NULL);                    /* band separator */
        free(o);
    }
    free(rgb);
}

/* Run-length encoding must actually fire on wide uniform rows, or a
 * full-width image emits one character per pixel per band and the escape
 * balloons. */
TEST(sixel_run_length_encodes) {
    int w = 200, h = 6;
    unsigned char *rgb = calloc((size_t)w * h * 3, 1);
    size_t n = 0;
    char *o = emit_sixel(rgb, w, h, &n);
    CHECK(o != NULL);
    if (o) {
        CHECK(strchr(o, '!') != NULL); /* an RLE run was emitted */
        /* Far smaller than one byte per pixel would be. */
        CHECK(n < (size_t)(w * h));
        free(o);
    }
    free(rgb);
}

TEST(sixel_rejects_bad_input) {
    unsigned char px[3] = {0};
    CHECK(emit_sixel(NULL, 4, 4, NULL) == NULL);
    CHECK(emit_sixel(px, 0, 4, NULL) == NULL);
    CHECK(emit_sixel(px, 4, 0, NULL) == NULL);
    CHECK(emit_sixel(px, -1, -1, NULL) == NULL);
}

/* #451 L1 — the sixel encoder's intermediate buffers are w*h*3 ints
 * (the dither working copy) and w*h bytes (the palette indices).
 * Unbounded dims would wrap size_t and under-allocate, after which the
 * band loops write out of bounds. Not reachable through the
 * terminal-bounded callers today, but the encoder is a public API, so
 * the overflow guard is verified here rather than left to luck. */
TEST(sixel_dims_overflow_guard) {
    CHECK(media_sixel_dims_ok(4, 6));
    CHECK(media_sixel_dims_ok(1920, 1080)); /* large but well within size_t */
    CHECK(!media_sixel_dims_ok(0, 10));
    CHECK(!media_sixel_dims_ok(10, 0));
    CHECK(!media_sixel_dims_ok(-1, -1));
    /* w*h*3*sizeof(int) overflows size_t. */
    CHECK(!media_sixel_dims_ok(INT_MAX, INT_MAX));
    /* And the encoder itself refuses those dims rather than
     * under-allocating and running the band loop past the buffer. */
    unsigned char px[3] = {0};
    CHECK(emit_sixel(px, INT_MAX, INT_MAX, NULL) == NULL);
}

/* Cells are ~2x taller than wide. Without correcting for that, every
 * image renders vertically stretched — the single most visible flaw in
 * naive terminal image output. */
TEST(cell_fitting_corrects_aspect) {
    int c = 0, r = 0;

    /* A SQUARE image needs about twice as many columns as rows. */
    media_fit_cells(100, 100, 200, 50, &c, &r);
    CHECK(r == 50);
    CHECK(c == 100);

    /* Wide image, column-limited. */
    media_fit_cells(400, 100, 80, 50, &c, &r);
    CHECK(c == 80);
    CHECK(r == 10); /* 80 / 4 / 2 */

    /* Never exceeds the box. */
    media_fit_cells(1000, 10, 40, 20, &c, &r);
    CHECK(c <= 40 && r <= 20);
    CHECK(c >= 1 && r >= 1);

    media_fit_cells(10, 1000, 40, 20, &c, &r);
    CHECK(c <= 40 && r <= 20);
    CHECK(c >= 1 && r >= 1);

    /* Degenerate input yields zeroes rather than a divide-by-zero. */
    media_fit_cells(0, 0, 80, 24, &c, &r);
    CHECK(c == 0 && r == 0);
    media_fit_cells(100, 100, 0, 0, &c, &r);
    CHECK(c == 0 && r == 0);
    media_fit_cells(100, 100, 80, 24, NULL, NULL); /* must not crash */
}

/* #451/#324 — first-party classification decides which media auto-renders
 * inline (grappa's own upload store) vs stays click-to-preview (any other
 * peer URL). MUST match cic's mediaLink.ts: host in {connect host} ∪
 * server alias set AND path under /uploads/, case-insensitive host,
 * scheme- and port-agnostic. A foreign host with a /uploads/ path is NOT
 * first-party (that is the whole point of the H1 fix), and an empty alias
 * list falls back restrictively to the connect host alone. */
TEST(first_party_url_classification) {
    const char *aliases[] = {"irc.sindro.me", "irc.sniffo.org"};

    /* Connect host + /uploads/ path. */
    CHECK(media_url_is_first_party("https://irc.example/uploads/a.png", "irc.example", NULL, 0));
    /* An alias host counts (the #324 multi-alias deployment). */
    CHECK(media_url_is_first_party("https://irc.sniffo.org/uploads/x.jpg", "irc.sindro.me", aliases, 2));
    /* Case-insensitive host, scheme- and port-agnostic. */
    CHECK(media_url_is_first_party("http://IRC.EXAMPLE:8080/uploads/x", "irc.example", NULL, 0));

    /* A foreign host is NOT first-party even with a /uploads/ path — H1. */
    CHECK(!media_url_is_first_party("https://evil.example/uploads/x.png", "irc.example", aliases, 2));
    /* Right host, wrong path. */
    CHECK(!media_url_is_first_party("https://irc.example/pub/x.png", "irc.example", NULL, 0));
    /* Non-http(s) scheme is never first-party. */
    CHECK(!media_url_is_first_party("file:///uploads/x", "irc.example", NULL, 0));
    /* Restrictive fallback: no aliases → only the connect host matches. */
    CHECK(!media_url_is_first_party("https://irc.sniffo.org/uploads/x", "irc.sindro.me", NULL, 0));
    /* Degenerate inputs. */
    CHECK(!media_url_is_first_party(NULL, "irc.example", NULL, 0));
    CHECK(!media_url_is_first_party("https:///uploads/x", "irc.example", NULL, 0)); /* empty host */
}

int main(void) {
    RUN(da1_sixel_parsing);
    RUN(env_detection);
    RUN(forced_protocol_overrides);
    RUN(detect_on_non_tty_is_safe);
    RUN(iterm2_framing);
    RUN(kitty_chunking);
    RUN(sixel_framing);
    RUN(sixel_run_length_encodes);
    RUN(sixel_rejects_bad_input);
    RUN(sixel_dims_overflow_guard);
    RUN(cell_fitting_corrects_aspect);
    RUN(first_party_url_classification);
    return test_report();
}
