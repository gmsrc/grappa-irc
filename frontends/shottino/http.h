/* http.h — pure HTTP/1.1 response-body decoding for shottino.
 *
 * Shottino's HTTP client (`http_request_raw` in shottino.c) talks to grappa
 * over a socket it does not control, so the response body is attacker-shaped
 * exactly like the websocket frames. The transfer-decoding is the one piece
 * of that path that is PURE — bytes in, bytes out, no socket / OpenSSL / app
 * state — so it lives here where it can be exercised under ASan/UBSan and
 * fuzzed for the overflow class. The rest of the HTTP path stays in
 * shottino.c because it is bound to the live TLS connection.
 */
#ifndef SHOTTINO_HTTP_H
#define SHOTTINO_HTTP_H

#include <stddef.h>

/* Decode an HTTP/1.1 `Transfer-Encoding: chunked` body.
 *
 * `body`/`len` is the raw body span; the decoder scans it and does not
 * require NUL-termination. Returns a freshly malloc'd, NUL-terminated buffer
 * whose decoded length is written to `*out_len` (the caller owns and frees
 * it), or NULL on allocation failure.
 *
 * Hardened against a hostile chunk size: the size is parsed with a size_t
 * overflow guard, and each chunk is bounds-checked with NON-wrapping
 * arithmetic (`n > len - pos`, never `pos + n > len` which wraps). A garbage
 * length — e.g. 16+ hex digits — is refused rather than driving an
 * out-of-bounds copy. Malformed framing stops decoding at the last good
 * chunk rather than aborting, matching lenient real-world HTTP clients. */
char *http_decode_chunked(const char *body, size_t len, size_t *out_len);

#endif /* SHOTTINO_HTTP_H */
