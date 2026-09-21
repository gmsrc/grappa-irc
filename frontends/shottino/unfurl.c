/* unfurl — see unfurl.h. */
#include "unfurl.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

/* ── Small text helpers ────────────────────────────────────────────── */

/* Case-insensitive find within a bounded region. */
static const char *find_ci_n(const char *hay, size_t n, const char *needle) {
    size_t m = strlen(needle);
    if (m == 0 || n < m) return NULL;
    for (size_t i = 0; i + m <= n; i++)
        if (strncasecmp(hay + i, needle, m) == 0) return hay + i;
    return NULL;
}

/* Append one UTF-8 encoding of `cp` to `out`, bounded. */
static void put_utf8(unsigned long cp, char *out, size_t out_sz, size_t *w) {
    char buf[4];
    size_t n;
    if (cp < 0x80) { buf[0] = (char)cp; n = 1; }
    else if (cp < 0x800) { buf[0] = (char)(0xC0 | (cp >> 6)); buf[1] = (char)(0x80 | (cp & 0x3F)); n = 2; }
    else if (cp < 0x10000) {
        buf[0] = (char)(0xE0 | (cp >> 12)); buf[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        buf[2] = (char)(0x80 | (cp & 0x3F)); n = 3;
    } else if (cp < 0x110000) {
        buf[0] = (char)(0xF0 | (cp >> 18)); buf[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
        buf[2] = (char)(0x80 | ((cp >> 6) & 0x3F)); buf[3] = (char)(0x80 | (cp & 0x3F)); n = 4;
    } else return;
    if (*w + n >= out_sz) return; /* whole character or nothing */
    memcpy(out + *w, buf, n);
    *w += n;
}

/* Decode `src[0..n)` into `out`: entities resolved, whitespace runs
 * collapsed to one space, ends trimmed, cut on a UTF-8 boundary. The
 * named entities are the handful that appear in titles; a numeric one
 * is any code point; an unknown one is kept as typed, which is what a
 * reader would see. */
static void clean_text(const char *src, size_t n, char *out, size_t out_sz) {
    static const struct { const char *name; unsigned long cp; } named[] = {
        { "amp", '&' }, { "lt", '<' }, { "gt", '>' }, { "quot", '"' }, { "apos", '\'' },
        { "nbsp", ' ' }, { "ndash", 0x2013 }, { "mdash", 0x2014 }, { "hellip", 0x2026 },
        { "laquo", 0xAB }, { "raquo", 0xBB }, { "copy", 0xA9 }, { "eacute", 0xE9 },
        { "egrave", 0xE8 }, { "agrave", 0xE0 }, { "uuml", 0xFC }, { "ouml", 0xF6 },
        { "auml", 0xE4 }, { "szlig", 0xDF }, { "rsquo", 0x2019 }, { "lsquo", 0x2018 },
        { "rdquo", 0x201D }, { "ldquo", 0x201C },
    };
    size_t w = 0;
    bool space = true;
    for (size_t i = 0; i < n && w + 1 < out_sz;) {
        unsigned char c = (unsigned char)src[i];
        if (c == '&') {
            const char *semi = memchr(src + i, ';', n - i > 12 ? 12 : n - i);
            if (semi) {
                size_t elen = (size_t)(semi - (src + i)) - 1;
                const char *ent = src + i + 1;
                unsigned long cp = 0;
                bool ok = false;
                if (elen > 1 && ent[0] == '#') {
                    char *end = NULL;
                    cp = (ent[1] == 'x' || ent[1] == 'X') ? strtoul(ent + 2, &end, 16)
                                                          : strtoul(ent + 1, &end, 10);
                    ok = end == semi && cp > 0;
                } else {
                    for (size_t k = 0; k < sizeof(named) / sizeof(named[0]); k++) {
                        if (strlen(named[k].name) == elen && strncmp(ent, named[k].name, elen) == 0) {
                            cp = named[k].cp;
                            ok = true;
                            break;
                        }
                    }
                }
                if (ok) {
                    if (cp == ' ') {
                        if (!space && w) out[w++] = ' ';
                        space = true;
                    } else {
                        put_utf8(cp, out, out_sz, &w);
                        space = false;
                    }
                    i = (size_t)(semi - src) + 1;
                    continue;
                }
            }
        }
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
            if (!space && w) out[w++] = ' ';
            space = true;
            i++;
            continue;
        }
        /* One whole UTF-8 sequence at a time, so the cut never tears one. */
        size_t seq = c < 0x80 ? 1 : (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 1;
        if (i + seq > n || w + seq >= out_sz) break;
        memcpy(out + w, src + i, seq);
        w += seq;
        i += seq;
        space = false;
    }
    while (w && out[w - 1] == ' ') w--;
    out[w] = 0;
}

/* ── Tag readers ───────────────────────────────────────────────────── */

/* The value of `attr` inside the tag starting at `tag` (which points at
 * '<'). Quoted or bare; NULL when absent. Sets *vlen. */
static const char *tag_attr(const char *tag, const char *tag_end, const char *attr, size_t *vlen) {
    size_t alen = strlen(attr);
    const char *p = tag + 1;
    while (p < tag_end) {
        /* An attribute starts after whitespace. */
        while (p < tag_end && isspace((unsigned char)*p)) p++;
        if (p >= tag_end) break;
        const char *name = p;
        while (p < tag_end && !isspace((unsigned char)*p) && *p != '=' && *p != '>' && *p != '/') p++;
        size_t nlen = (size_t)(p - name);
        while (p < tag_end && isspace((unsigned char)*p)) p++;
        const char *value = NULL;
        size_t vl = 0;
        if (p < tag_end && *p == '=') {
            p++;
            while (p < tag_end && isspace((unsigned char)*p)) p++;
            if (p < tag_end && (*p == '"' || *p == '\'')) {
                char q = *p++;
                value = p;
                while (p < tag_end && *p != q) p++;
                vl = (size_t)(p - value);
                if (p < tag_end) p++;
            } else {
                value = p;
                while (p < tag_end && !isspace((unsigned char)*p) && *p != '>') p++;
                vl = (size_t)(p - value);
            }
        } else if (p < tag_end && *p != '>') {
            /* A bare attribute (or the '/' of a self-close): skip it. */
            if (nlen == 0) p++;
        }
        if (nlen == alen && strncasecmp(name, attr, alen) == 0) {
            *vlen = vl;
            return value;
        }
        if (nlen == 0 && value == NULL) p++;
    }
    return NULL;
}

/* The content= of the <meta> whose property= or name= is `key`. */
static bool meta_content(const char *html, size_t len, const char *key, char *out, size_t out_sz) {
    const char *p = html;
    const char *end = html + len;
    while ((p = find_ci_n(p, (size_t)(end - p), "<meta")) != NULL) {
        const char *close = memchr(p, '>', (size_t)(end - p));
        if (!close) break;
        size_t vl = 0;
        const char *v = tag_attr(p, close, "property", &vl);
        if (!v) v = tag_attr(p, close, "name", &vl);
        if (v && vl == strlen(key) && strncasecmp(v, key, vl) == 0) {
            size_t cl = 0;
            const char *c = tag_attr(p, close, "content", &cl);
            if (c && cl) {
                clean_text(c, cl, out, out_sz);
                if (out[0]) return true;
            }
        }
        p = close + 1;
    }
    return false;
}

static bool title_text(const char *html, size_t len, char *out, size_t out_sz) {
    const char *t = find_ci_n(html, len, "<title");
    if (!t) return false;
    const char *open_end = memchr(t, '>', len - (size_t)(t - html));
    if (!open_end) return false;
    const char *body = open_end + 1;
    const char *close = find_ci_n(body, len - (size_t)(body - html), "</title");
    if (!close) return false;
    clean_text(body, (size_t)(close - body), out, out_sz);
    return out[0] != 0;
}

/* The first prose on the page: the body with script, style, nav,
 * header and footer elements removed whole, tags dropped, whitespace
 * collapsed — cut to the field. A heading counts as prose; a menu does
 * not, and a description that is the site's navigation is the failure
 * this exists to avoid. */
static bool body_prose(const char *html, size_t len, char *out, size_t out_sz) {
    static const char *const skip_open[] = { "<script", "<style", "<nav", "<header", "<footer", "<noscript", "<svg", "<template" };
    static const char *const skip_close[] = { "</script", "</style", "</nav", "</header", "</footer", "</noscript", "</svg", "</template" };
    const char *start = find_ci_n(html, len, "<body");
    const char *p = start ? start : html;
    const char *end = html + len;
    char *raw = malloc(out_sz * 4);
    if (!raw) return false;
    size_t w = 0;
    while (p < end && w + 1 < out_sz * 4) {
        if (*p == '<') {
            bool skipped = false;
            for (size_t k = 0; k < sizeof(skip_open) / sizeof(skip_open[0]); k++) {
                size_t ol = strlen(skip_open[k]);
                if ((size_t)(end - p) > ol && strncasecmp(p, skip_open[k], ol) == 0 &&
                    (isspace((unsigned char)p[ol]) || p[ol] == '>')) {
                    const char *c = find_ci_n(p, (size_t)(end - p), skip_close[k]);
                    p = c ? c : end;
                    skipped = true;
                    break;
                }
            }
            if (!skipped || p == end) { /* fall through to skip the tag itself */ }
            const char *gt = p < end ? memchr(p, '>', (size_t)(end - p)) : NULL;
            p = gt ? gt + 1 : end;
            raw[w++] = ' ';
            continue;
        }
        raw[w++] = *p++;
    }
    clean_text(raw, w, out, out_sz);
    free(raw);
    return out[0] != 0;
}

/* ── URL resolution ────────────────────────────────────────────────── */

static bool is_web_url(const char *u) {
    return strncasecmp(u, "http://", 7) == 0 || strncasecmp(u, "https://", 8) == 0;
}

/* Resolve `ref` against `base` into `out`. Handles absolute, scheme-
 * relative (`//host/x`), root-relative (`/x`) and path-relative (`x`);
 * refuses anything that does not come out http(s). */
/* prefix[0..plen) + rest into out, or false when it would not fit — a
 * truncated URL is a different URL, never a shorter one. plen 0 means
 * the whole prefix. */
static bool join(char *out, size_t out_sz, const char *prefix, size_t plen, const char *rest) {
    if (plen == 0) plen = strlen(prefix);
    size_t rl = strlen(rest);
    if (plen + rl + 1 > out_sz) return false;
    memcpy(out, prefix, plen);
    memcpy(out + plen, rest, rl + 1);
    return true;
}

static bool resolve_url(const char *base, const char *ref, char *out, size_t out_sz) {
    while (*ref == ' ') ref++;
    if (is_web_url(ref)) return join(out, out_sz, ref, 0, "");
    if (!is_web_url(base)) return false;
    const char *scheme_end = strstr(base, "://");
    const char *host = scheme_end + 3;
    const char *path = strchr(host, '/');
    if (ref[0] == '/' && ref[1] == '/') {
        /* scheme + ':' + ref */
        char scheme[16];
        size_t sl = (size_t)(scheme_end - base);
        if (sl + 1 >= sizeof(scheme)) return false;
        memcpy(scheme, base, sl);
        scheme[sl] = ':';
        scheme[sl + 1] = 0;
        return join(out, out_sz, scheme, 0, ref);
    }
    if (ref[0] == '/') return join(out, out_sz, base, (size_t)((path ? path : host + strlen(host)) - base), ref);
    if (ref[0] == 0 || ref[0] == '#' || strchr(ref, ':')) return false; /* mailto:, data:, javascript: … */
    /* Path-relative: up to and including the last '/' of the base path. */
    const char *last = path ? strrchr(path, '/') : NULL;
    if (last) return join(out, out_sz, base, (size_t)(last + 1 - base), ref);
    char with_slash[UNFURL_URL];
    if (strlen(base) + 2 > sizeof(with_slash)) return false;
    snprintf(with_slash, sizeof(with_slash), "%s/", base);
    return join(out, out_sz, with_slash, 0, ref);
}

/* ── The reader ────────────────────────────────────────────────────── */

bool unfurl_extract(const char *html, size_t len, const char *base, struct unfurl *out) {
    memset(out, 0, sizeof(*out));
    if (!html || len == 0) return false;
    /* The tags live in <head>; a truncated fetch still has that. */
    if (!meta_content(html, len, "og:title", out->title, sizeof(out->title)))
        if (!meta_content(html, len, "twitter:title", out->title, sizeof(out->title)))
            title_text(html, len, out->title, sizeof(out->title));
    if (!meta_content(html, len, "og:description", out->description, sizeof(out->description)))
        if (!meta_content(html, len, "twitter:description", out->description, sizeof(out->description)))
            if (!meta_content(html, len, "description", out->description, sizeof(out->description)))
                body_prose(html, len, out->description, sizeof(out->description));
    char img[UNFURL_URL] = "";
    if (!meta_content(html, len, "og:image", img, sizeof(img)))
        meta_content(html, len, "twitter:image", img, sizeof(img));
    if (img[0] && !resolve_url(base, img, out->image, sizeof(out->image))) out->image[0] = 0;
    return out->title[0] || out->description[0];
}
