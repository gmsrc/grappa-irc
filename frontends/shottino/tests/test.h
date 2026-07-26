/* test.h — the smallest thing that can hold shottino honest.
 *
 * Shottino shipped without any test target. The wire-narrowing and
 * formatting code being added for cicchetto parity is pure (bytes in,
 * typed values out) and is exactly the kind of code that rots silently in
 * C, so it gets tests. No framework dependency: a header of macros, one
 * `main` per suite, non-zero exit on failure.
 *
 * Usage:
 *   TEST(name) { ... CHECK(cond); CHECK_STR(a, b); }
 *   int main(void) { RUN(name); return test_report(); }
 */
#ifndef SHOTTINO_TEST_H
#define SHOTTINO_TEST_H

#include <stdio.h>
#include <string.h>

static int test_failures;
static int test_checks;
static const char *test_current;

#define TEST(name) static void test_##name(void)

#define RUN(name)                                                                                  \
    do {                                                                                           \
        test_current = #name;                                                                      \
        test_##name();                                                                             \
    } while (0)

#define CHECK(cond)                                                                                \
    do {                                                                                           \
        test_checks++;                                                                             \
        if (!(cond)) {                                                                             \
            test_failures++;                                                                       \
            fprintf(stderr, "FAIL %s:%d [%s] %s\n", __FILE__, __LINE__, test_current, #cond);      \
        }                                                                                          \
    } while (0)

/* String equality with both values printed on failure — a bare CHECK on
 * strcmp tells you it differed but not how, which is the whole question. */
#define CHECK_STR(actual, expect)                                                                  \
    do {                                                                                           \
        test_checks++;                                                                             \
        const char *a_ = (actual);                                                                 \
        const char *e_ = (expect);                                                                 \
        if (!a_ || !e_ || strcmp(a_, e_) != 0) {                                                   \
            test_failures++;                                                                       \
            fprintf(stderr, "FAIL %s:%d [%s] expected \"%s\", got \"%s\"\n", __FILE__, __LINE__,   \
                    test_current, e_ ? e_ : "(null)", a_ ? a_ : "(null)");                         \
        }                                                                                          \
    } while (0)

#define CHECK_LONG(actual, expect)                                                                 \
    do {                                                                                           \
        test_checks++;                                                                             \
        long a_ = (long)(actual);                                                                  \
        long e_ = (long)(expect);                                                                  \
        if (a_ != e_) {                                                                            \
            test_failures++;                                                                       \
            fprintf(stderr, "FAIL %s:%d [%s] expected %ld, got %ld\n", __FILE__, __LINE__,         \
                    test_current, e_, a_);                                                         \
        }                                                                                          \
    } while (0)

static int test_report(void) {
    if (test_failures) {
        fprintf(stderr, "\n%d/%d checks FAILED\n", test_failures, test_checks);
        return 1;
    }
    fprintf(stderr, "%d checks passed\n", test_checks);
    return 0;
}

#endif /* SHOTTINO_TEST_H */
