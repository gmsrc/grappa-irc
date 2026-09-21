/* unfurl — what a page says about itself, read off its HTML.
 *
 * Pure: bytes in, three strings out. The reader is deliberately not an
 * HTML parser — it wants the <head>'s Open Graph tags, falling back to
 * <title> and the first prose — and every case here is one that made a
 * card say something wrong in a real channel: an entity left raw, a
 * relative image never resolved, a description that was the nav bar. */
#include "../unfurl.h"
#include "test.h"

#include <string.h>

TEST(open_graph_wins_and_entities_are_decoded) {
    const char *html =
        "<html><head><title>Fallback &amp; Co</title>"
        "<meta property=\"og:title\" content=\"Real &quot;Title&quot; &#8212; site\">"
        "<meta name=\"description\" content=\"meta desc\">"
        "<meta property=\"og:description\" content=\"OG desc &lt;b&gt; &#39;q&#39;\">"
        "<meta property=\"og:image\" content=\"https://img.example/a.png\">"
        "</head><body><p>body text</p></body></html>";
    struct unfurl u;
    CHECK(unfurl_extract(html, strlen(html), "https://site.example/page", &u));
    CHECK_STR(u.title, "Real \"Title\" \xe2\x80\x94 site");
    CHECK_STR(u.description, "OG desc <b> 'q'");
    CHECK_STR(u.image, "https://img.example/a.png");
}

TEST(title_and_meta_description_are_the_fallback) {
    const char *html =
        "<html><head>\n<TITLE>\n  Plain   page\n</TITLE>\n"
        "<meta content=\"the meta one\" name=\"description\" />"
        "</head><body>irrelevant</body></html>";
    struct unfurl u;
    CHECK(unfurl_extract(html, strlen(html), "https://site.example/", &u));
    CHECK_STR(u.title, "Plain page");
    CHECK_STR(u.description, "the meta one");
    CHECK_STR(u.image, "");
}

TEST(prose_is_the_last_resort_and_skips_script_and_nav) {
    const char *html =
        "<html><head><title>T</title><style>.x{}</style><script>var a='<p>no</p>';</script></head>"
        "<body><nav><a>Home</a> <a>About</a></nav><h1>Heading</h1>"
        "<p>First   real\nparagraph, with &amp; in it.</p><p>Second.</p></body></html>";
    struct unfurl u;
    CHECK(unfurl_extract(html, strlen(html), "https://site.example/", &u));
    CHECK_STR(u.title, "T");
    CHECK(strncmp(u.description, "Heading First real paragraph, with & in it. Second.", 40) == 0);
    CHECK(strstr(u.description, "Home") == NULL);
    CHECK(strstr(u.description, "var a") == NULL);
}

TEST(a_relative_image_is_resolved_against_the_page) {
    struct unfurl u;
    const char *a = "<head><title>t</title><meta property=\"og:image\" content=\"/img/x.jpg\"></head>";
    CHECK(unfurl_extract(a, strlen(a), "https://site.example/dir/page.html", &u));
    CHECK_STR(u.image, "https://site.example/img/x.jpg");
    const char *b = "<head><title>t</title><meta property=\"og:image\" content=\"x.jpg\"></head>";
    CHECK(unfurl_extract(b, strlen(b), "https://site.example/dir/page.html", &u));
    CHECK_STR(u.image, "https://site.example/dir/x.jpg");
    const char *c = "<head><title>t</title><meta property=\"og:image\" content=\"//cdn.example/y.png\"></head>";
    CHECK(unfurl_extract(c, strlen(c), "http://site.example/", &u));
    CHECK_STR(u.image, "http://cdn.example/y.png");
    /* Not a web image at all: refused rather than handed to a decoder. */
    const char *d = "<head><title>t</title><meta property=\"og:image\" content=\"file:///etc/passwd\"></head>";
    CHECK(unfurl_extract(d, strlen(d), "https://site.example/", &u));
    CHECK_STR(u.image, "");
}

TEST(nothing_to_say_is_false_and_long_text_is_cut_on_a_character) {
    struct unfurl u;
    const char *none = "<html><body><script>x()</script></body></html>";
    CHECK(!unfurl_extract(none, strlen(none), "https://site.example/", &u));
    /* A title far past the field: cut, and cut between UTF-8 characters
     * — a card that ends in half a glyph draws a replacement box. */
    char big[4096];
    size_t n = (size_t)snprintf(big, sizeof(big), "<title>");
    for (int i = 0; i < 300; i++) n += (size_t)snprintf(big + n, sizeof(big) - n, "\xc3\xa9");
    snprintf(big + n, sizeof(big) - n, "</title>");
    CHECK(unfurl_extract(big, strlen(big), "https://site.example/", &u));
    size_t len = strlen(u.title);
    CHECK(len < sizeof(u.title));
    CHECK(len % 2 == 0); /* every é is two bytes; an odd length is a torn one */
}

int main(void) {
    RUN(open_graph_wins_and_entities_are_decoded);
    RUN(title_and_meta_description_are_the_fallback);
    RUN(prose_is_the_last_resort_and_skips_script_and_nav);
    RUN(a_relative_image_is_resolved_against_the_page);
    RUN(nothing_to_say_is_false_and_long_text_is_cut_on_a_character);
    return test_report();
}
