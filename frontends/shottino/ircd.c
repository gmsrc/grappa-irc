/* ircd.c — see ircd.h. Pure: no sockets, no app state, no allocation. */
#include "ircd.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>

#define IRCD_DEFAULT_PORT "6667"
#define IRCD_DEFAULT_HOST "127.0.0.1"

static void copy_bounded(char *out, size_t out_sz, const char *start, size_t len) {
    if (!out_sz) return;
    if (len >= out_sz) len = out_sz - 1;
    memcpy(out, start, len);
    out[len] = '\0';
}

bool ircd_parse_line(const char *line, struct ircd_msg *out) {
    memset(out, 0, sizeof(*out));
    if (!line) return false;
    const char *p = line;
    while (*p == ' ') p++;

    if (*p == ':') {
        p++;
        const char *start = p;
        while (*p && *p != ' ') p++;
        copy_bounded(out->prefix, sizeof(out->prefix), start, (size_t)(p - start));
        while (*p == ' ') p++;
    }

    const char *start = p;
    while (*p && *p != ' ') p++;
    if (p == start) return false;
    copy_bounded(out->command, sizeof(out->command), start, (size_t)(p - start));
    for (char *c = out->command; *c; c++) *c = (char)toupper((unsigned char)*c);

    while (*p) {
        while (*p == ' ') p++;
        if (!*p) break;
        if (out->param_count >= IRCD_MAX_PARAMS) break;
        if (*p == ':') {
            /* The trailing parameter is the rest of the line, spaces and
             * all, and there is at most one. */
            p++;
            copy_bounded(out->params[out->param_count], IRCD_PARAM_MAX, p, strlen(p));
            out->param_count++;
            break;
        }
        start = p;
        while (*p && *p != ' ') p++;
        copy_bounded(out->params[out->param_count], IRCD_PARAM_MAX, start, (size_t)(p - start));
        out->param_count++;
    }
    return true;
}

bool ircd_command_is(const struct ircd_msg *m, const char *name) {
    return strcasecmp(m->command, name) == 0;
}

bool ircd_parse_bind(const char *spec, char *host, size_t host_sz, char *port, size_t port_sz) {
    if (!host_sz || !port_sz) return false;
    snprintf(host, host_sz, "%s", IRCD_DEFAULT_HOST);
    snprintf(port, port_sz, "%s", IRCD_DEFAULT_PORT);
    if (!spec || !*spec) return true;

    /* "[addr]" or "[addr]:port" — the only unambiguous way to write an
     * IPv6 address with a port. */
    if (*spec == '[') {
        const char *close = strchr(spec, ']');
        if (!close || close == spec + 1) return false;
        copy_bounded(host, host_sz, spec + 1, (size_t)(close - spec - 1));
        if (close[1] == ':' && close[2]) snprintf(port, port_sz, "%s", close + 2);
        else if (close[1]) return false;
        return true;
    }

    bool all_digits = true;
    size_t colons = 0;
    for (const char *c = spec; *c; c++) {
        if (*c == ':') colons++;
        if (!isdigit((unsigned char)*c)) all_digits = false;
    }
    if (all_digits) { /* a bare port keeps the loopback default */
        snprintf(port, port_sz, "%s", spec);
        return true;
    }
    if (colons > 1) { /* a bare IPv6 literal: "::1", "fe80::1" */
        snprintf(host, host_sz, "%s", spec);
        return true;
    }
    if (colons == 1) {
        const char *sep = strchr(spec, ':');
        if (sep == spec || !sep[1]) return false;
        copy_bounded(host, host_sz, spec, (size_t)(sep - spec));
        snprintf(port, port_sz, "%s", sep + 1);
        return true;
    }
    snprintf(host, host_sz, "%s", spec);
    return true;
}

bool ircd_bind_is_loopback(const char *host) {
    if (!host || !*host) return false;
    if (strcmp(host, "::1") == 0) return true;
    if (strcasecmp(host, "localhost") == 0) return true;
    /* The whole 127/8 block, not just 127.0.0.1: a bridge on 127.0.0.2 is
     * exactly as unreachable from outside. */
    if (strncmp(host, "127.", 4) == 0) return true;
    return false;
}

void ircd_split_pass(const char *pass, char *network, size_t network_sz, char *secret,
                     size_t secret_sz) {
    if (network_sz) network[0] = '\0';
    if (secret_sz) secret[0] = '\0';
    if (!pass) return;
    const char *colon = strchr(pass, ':');
    if (!colon) {
        /* No colon: it is a network name or a password, and only the
         * caller (who knows the network names) can say which. */
        snprintf(network, network_sz, "%s", pass);
        snprintf(secret, secret_sz, "%s", pass);
        return;
    }
    copy_bounded(network, network_sz, pass, (size_t)(colon - pass));
    snprintf(secret, secret_sz, "%s", colon + 1);
}

/* The casemapping every IRC name in this client is compared under.
 *
 * ASCII: `A-Z` and nothing else. It used to also fold `[ ] \ ~` to
 * `{ } | ^`, which is RFC1459 and is NOT what the ircd does — bahamut
 * (azzurra) advertises AND implements `CASEMAPPING=ascii`, so `foo[1]`
 * and `foo{1}` are two DIFFERENT people and `#chan[1]` two different
 * channels. Folding them together merged a stranger into your nicklist
 * (grappa's #525, corrected server-side in
 * `Grappa.IRC.Identifier.canonical_nick/1`); this is the client twin of
 * that fix, and the ONE fold the whole binary uses — the app's window
 * lookups call it through `irc_name_eq`.
 *
 * Bytes above 127 are left alone deliberately: the ircd keeps `#CAFÉ`
 * and `#café` apart, and a locale-aware tolower would not. */
static char fold_char(char c) {
    return (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
}

void ircd_fold(const char *in, char *out, size_t out_sz) {
    if (!out_sz) return;
    size_t n = 0;
    for (const char *c = in ? in : ""; *c && n + 1 < out_sz; c++) out[n++] = fold_char(*c);
    out[n] = '\0';
}

bool ircd_name_equal(const char *a, const char *b) {
    if (!a || !b) return false;
    while (*a && *b) {
        if (fold_char(*a) != fold_char(*b)) return false;
        a++;
        b++;
    }
    return *a == *b;
}

void ircd_sender_prefix(const char *nick, char *out, size_t out_sz) {
    char clean[128];
    ircd_sanitize(nick && *nick ? nick : "grappa", clean, sizeof(clean));
    /* A nick is not allowed spaces or '!' or '@'; a hostile one would
     * otherwise forge a different sender. */
    for (char *c = clean; *c; c++)
        if (*c == ' ' || *c == '!' || *c == '@' || *c == ':') *c = '_';
    snprintf(out, out_sz, "%s!%s@grappa", clean, clean);
}

void ircd_time_tag(long server_time_ms, bool wanted, char *out, size_t out_sz) {
    if (out_sz) out[0] = '\0';
    if (!wanted || server_time_ms <= 0) return;
    time_t secs = (time_t)(server_time_ms / 1000);
    long ms = server_time_ms % 1000;
    struct tm tm;
    if (!gmtime_r(&secs, &tm)) return;
    char stamp[32];
    if (strftime(stamp, sizeof(stamp), "%Y-%m-%dT%H:%M:%S", &tm) == 0) return;
    snprintf(out, out_sz, "@time=%s.%03ldZ ", stamp, ms);
}

bool ircd_parse_time(const char *s, long *out_ms) {
    if (!s || !*s) return false;
    struct tm tm;
    memset(&tm, 0, sizeof(tm));
    int year, mon, day, hour, min, sec, ms = 0;
    int n = sscanf(s, "%4d-%2d-%2dT%2d:%2d:%2d.%3d", &year, &mon, &day, &hour, &min, &sec, &ms);
    if (n < 6) return false;
    tm.tm_year = year - 1900;
    tm.tm_mon = mon - 1;
    tm.tm_mday = day;
    tm.tm_hour = hour;
    tm.tm_min = min;
    tm.tm_sec = sec;
    /* timegm, not mktime: the format is UTC by definition, and reading
     * it in the local zone would move every selector by the offset. */
    time_t secs = timegm(&tm);
    if (secs == (time_t)-1) return false;
    *out_ms = (long)secs * 1000 + ms;
    return true;
}

bool ircd_parse_selector(const char *s, struct ircd_selector *out) {
    memset(out, 0, sizeof(*out));
    if (!s || !*s) return false;
    if (strcmp(s, "*") == 0) {
        out->kind = IRCD_SEL_STAR;
        return true;
    }
    if (strncasecmp(s, "timestamp=", 10) == 0) {
        if (!ircd_parse_time(s + 10, &out->time_ms)) return false;
        out->kind = IRCD_SEL_TIME;
        return true;
    }
    if (strncasecmp(s, "msgid=", 6) == 0) {
        char *end = NULL;
        long id = strtol(s + 6, &end, 10);
        if (!end || end == s + 6 || id <= 0) return false;
        out->msgid = id;
        out->kind = IRCD_SEL_MSGID;
        return true;
    }
    return false;
}

void ircd_tags(long server_time_ms, bool want_time, long msgid, bool want_tags,
               const char *batch_ref, char *out, size_t out_sz) {
    if (!out_sz) return;
    out[0] = '\0';
    char stamp[64] = "";
    if (want_time) ircd_time_tag(server_time_ms, true, stamp, sizeof(stamp));
    /* ircd_time_tag writes the whole tag with its trailing space; here it
     * is one tag among several, so the decoration is taken off again. */
    size_t stamp_len = strlen(stamp);
    if (stamp_len > 2) {
        memmove(stamp, stamp + 1, stamp_len - 1);
        stamp[stamp_len - 2] = '\0';
    } else {
        stamp[0] = '\0';
    }
    bool have_msgid = want_tags && msgid > 0;
    bool have_batch = want_tags && batch_ref && *batch_ref;
    if (!stamp[0] && !have_msgid && !have_batch) return;
    size_t used = 0;
    used += (size_t)snprintf(out + used, out_sz - used, "@");
    if (stamp[0]) used += (size_t)snprintf(out + used, out_sz - used, "%s", stamp);
    if (have_msgid)
        used += (size_t)snprintf(out + used, out_sz - used, "%smsgid=%ld", used > 1 ? ";" : "",
                                 msgid);
    if (have_batch)
        used += (size_t)snprintf(out + used, out_sz - used, "%sbatch=%s", used > 1 ? ";" : "",
                                 batch_ref);
    snprintf(out + used, out_sz - used, " ");
}

void ircd_sanitize(const char *in, char *out, size_t out_sz) {
    if (!out_sz) return;
    size_t n = 0;
    for (const char *c = in ? in : ""; *c && n + 1 < out_sz; c++) {
        /* CR and LF end a line; NUL ends a string. Everything else,
         * including the CTCP \x01 and mIRC colour codes, is carried
         * through untouched — this is a bridge, not a filter. */
        if (*c == '\r' || *c == '\n') continue;
        out[n++] = *c;
    }
    out[n] = '\0';
}

bool ircd_needs_trailing(const char *text) {
    if (!text || !*text) return true;
    if (*text == ':') return true;
    return strchr(text, ' ') != NULL;
}

void ircd_member_sigils(const char *modes, const char *sigils, bool multi_prefix, char *out,
                        size_t out_sz) {
    if (!out_sz) return;
    out[0] = '\0';
    if (!modes || !sigils) return;
    size_t n = 0;
    for (const char *s = sigils; *s && n + 1 < out_sz; s++) {
        if (!strchr(modes, *s)) continue;
        out[n++] = *s;
        out[n] = '\0';
        /* Without multi-prefix a client expects exactly one sigil, the
         * highest — sending "@+" to a client that did not ask for it
         * makes the nick itself read as "+nick". */
        if (!multi_prefix) return;
    }
}
