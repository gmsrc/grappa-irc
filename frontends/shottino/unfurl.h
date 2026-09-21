/* unfurl — what a page says about itself, read off its HTML.
 *
 * A link posted in a channel is a URL and nothing more; the card drawn
 * under it wants the page's own title, a line or two of what it is, and
 * the picture it nominates. Sites publish exactly that for link previews
 * — the Open Graph tags — and this reads them, falling back to <title>,
 * the meta description, and finally the first prose on the page.
 *
 * This is the PURE half: bytes in, three strings out, no sockets. It is
 * deliberately not an HTML parser. It looks for a handful of tags in a
 * document that may be truncated (the fetch is capped) or malformed,
 * and it must never do worse than say nothing. Every string is
 * entity-decoded, whitespace-collapsed, and cut on a UTF-8 boundary. */
#ifndef SHOTTINO_UNFURL_H
#define SHOTTINO_UNFURL_H

#include <stdbool.h>
#include <stddef.h>

#define UNFURL_TITLE 160
#define UNFURL_DESC 400
#define UNFURL_URL 1024

struct unfurl {
    char title[UNFURL_TITLE];
    char description[UNFURL_DESC];
    /* Absolute http(s) URL of the page's nominated image, or "". A
     * relative one is resolved against `base`; any other scheme is
     * refused here rather than handed to a decoder. */
    char image[UNFURL_URL];
};

/* Fill `out` from `html` (`len` bytes, need not be NUL-terminated).
 * `base` is the page's own URL, for resolving a relative image. Returns
 * false when neither a title nor a description could be found — a card
 * with nothing to say is not drawn. */
bool unfurl_extract(const char *html, size_t len, const char *base, struct unfurl *out);

#endif
