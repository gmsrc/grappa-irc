/* test_http.c — regression tests for the chunked-transfer decoder.
 *
 * The headline case is #446-R1: a hostile HTTP server sends a chunk size
 * that overflows size_t, and the old `pos + n > len` guard wrapped and let
 * an unbounded memcpy through. These run under ASan+UBSan (see the Makefile),
 * so an out-of-bounds copy fails the suite loudly instead of silently
 * corrupting the heap. */
#include "test.h"

#include <stdlib.h>

#include "../http.h"

/* Helper: decode a NUL-terminated literal (len = strlen), returning the
 * malloc'd result and its decoded length. */
static char *decode(const char *body, size_t *out_len) {
    return http_decode_chunked(body, strlen(body), out_len);
}

TEST(single_chunk) {
    size_t n = 0;
    char *out = decode("5\r\nHELLO\r\n0\r\n\r\n", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 5);
    CHECK_STR(out, "HELLO");
    free(out);
}

TEST(multiple_chunks) {
    size_t n = 0;
    char *out = decode("3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 5);
    CHECK_STR(out, "abcde");
    free(out);
}

TEST(hex_size_uppercase_and_lower) {
    size_t n = 0;
    /* 0x0b = 11 bytes: "hello world" */
    char *out = decode("b\r\nhello world\r\n0\r\n\r\n", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 11);
    CHECK_STR(out, "hello world");
    free(out);
}

TEST(empty_body) {
    size_t n = 123;
    char *out = decode("", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 0);
    free(out);
}

/* #446-R1 regression: a 16-hex-digit chunk size is SIZE_MAX. The overflow
 * guard does not trip (it fits exactly), so the non-wrapping bounds check is
 * what must refuse it — the old `pos + n > len` wrapped below `len` and let
 * the memcpy run. Expect: no bytes decoded, no overflow (ASan is the judge). */
TEST(chunk_size_size_max_rejected) {
    size_t n = 123;
    char *out = decode("FFFFFFFFFFFFFFFF\r\noverflow me\r\n0\r\n\r\n", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 0);
    free(out);
}

/* A 17+ hex-digit size overflows during accumulation — the overflow guard is
 * what refuses this one. Same observable outcome: rejected, no overflow. */
TEST(chunk_size_overflow_rejected) {
    size_t n = 123;
    char *out = decode("1FFFFFFFFFFFFFFFF\r\noverflow me\r\n0\r\n\r\n", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 0);
    free(out);
}

/* A valid prefix chunk is preserved; the decoder stops AT the absurd chunk
 * rather than dropping everything — and, critically, does not overflow. */
TEST(good_prefix_then_absurd_chunk) {
    size_t n = 0;
    char *out = decode("3\r\nabc\r\nFFFFFFFFFFFFFFFF\r\nx\r\n0\r\n\r\n", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 3);
    CHECK_STR(out, "abc");
    free(out);
}

/* A chunk size larger than the remaining body (but not overflowing) is also
 * refused — the honest large-value path of the same bounds check. */
TEST(chunk_size_exceeds_body_rejected) {
    size_t n = 0;
    char *out = decode("ff\r\nonly-a-few\r\n", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 0);
    free(out);
}

int main(void) {
    RUN(single_chunk);
    RUN(multiple_chunks);
    RUN(hex_size_uppercase_and_lower);
    RUN(empty_body);
    RUN(chunk_size_size_max_rejected);
    RUN(chunk_size_overflow_rejected);
    RUN(good_prefix_then_absurd_chunk);
    RUN(chunk_size_exceeds_body_rejected);
    return test_report();
}
