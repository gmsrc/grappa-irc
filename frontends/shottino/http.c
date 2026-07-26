/* http.c — see http.h. */
#include "http.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Local hex-digit decoder, like mirc.c's hex_val — each pure module keeps
 * its own tiny primitive rather than reaching across a module boundary. */
static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

char *http_decode_chunked(const char *body, size_t len, size_t *out_len) {
    /* The decoded body is never larger than the source span (chunk data is a
     * subset of the input), so one allocation is enough. */
    char *out = malloc(len + 1);
    if (!out) return NULL;
    size_t pos = 0, w = 0;
    while (pos < len) {
        size_t line = pos;
        while (line + 1 < len && !(body[line] == '\r' && body[line + 1] == '\n')) line++;
        if (line + 1 >= len) break;
        size_t n = 0;
        bool overflow = false;
        for (size_t i = pos; i < line; i++) {
            int v = hexval(body[i]);
            if (v < 0) break;
            /* A hostile server can send a 16+ hex-digit chunk size that
             * overflows size_t; then a `pos + n` bounds guard would wrap and
             * pass, turning the memcpy into an unbounded heap overwrite.
             * Detect the overflow before the multiply that would cause it. */
            if (n > (SIZE_MAX - (size_t)v) / 16) { overflow = true; break; }
            n = n * 16 + (size_t)v;
        }
        pos = line + 2; /* pos <= len: the \r\n was found within len above */
        /* Bounds-check WITHOUT wrapping: pos <= len is guaranteed, so
         * `len - pos` cannot underflow and `n > len - pos` is exact even for
         * n == SIZE_MAX (the exactly-16-hex-digit case the overflow guard
         * above does not trip). */
        if (overflow || n == 0 || n > len - pos) break;
        memcpy(out + w, body + pos, n);
        w += n;
        pos += n + 2;
    }
    out[w] = 0;
    *out_len = w;
    return out;
}
