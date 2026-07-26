/* alias.c — see alias.h. */
#include "alias.h"

#include <stdio.h>
#include <string.h>
#include <strings.h>

/* The single list of built-in verbs. `alias_is_builtin` is the only
 * consumer, but keeping it here (rather than inline in the dispatcher)
 * means the shadowing rule and the dispatcher's verb set are edited
 * together — a new command added to one without the other is the drift
 * this is meant to prevent. */
static const char *const BUILTINS[] = {
    "quit",   "exit",     "help",    "chat",    "archive",   "settings", "admin",
    "share",  "open",     "clear",   "close",   "join",      "j",        "part",
    "nick",   "msg",      "query",   "q",       "me",        "disconnect", "connect",
    "away",   "whois",    "whowas",  "who",     "names",     "lusers",   "members",
    "users",  "topic",    "quote",   "oper",    "op",        "deop",     "voice",
    "devoice","kick",     "ban",     "unban",   "banlist",   "invite",   "umode",
    "mode",   "links",    "motd",    "info",    "version",   "stats",    "rehash",
    "kb",     "kickban",  "cs",      "ns",      "ms",        "os",       "hs",
    "rs",     "notify",   "hilight", "dehilight", "highlight", "watch",  "alias",
    "unalias","list",     "window",  "win",     "w",         "upload", NULL};

bool alias_is_builtin(const char *verb) {
    if (!verb) return false;
    if (*verb == '/') verb++;
    for (size_t i = 0; BUILTINS[i]; i++)
        if (strcasecmp(verb, BUILTINS[i]) == 0) return true;
    return false;
}

static const char *strip_slash(const char *name) {
    if (name && *name == '/') return name + 1;
    return name;
}

alias_set_result alias_set(struct alias_table *t, const char *name, const char *expansion) {
    name = strip_slash(name);
    if (!t || !name || !*name || !expansion || !*expansion) return ALIAS_SET_INVALID;
    if (alias_is_builtin(name)) return ALIAS_SET_BUILTIN;

    struct alias_entry *slot = NULL;
    for (size_t i = 0; i < t->count; i++)
        if (strcasecmp(t->entries[i].name, name) == 0) slot = &t->entries[i];
    if (!slot) {
        if (t->count >= ALIAS_MAX_ENTRIES) return ALIAS_SET_FULL;
        slot = &t->entries[t->count++];
    }
    snprintf(slot->name, sizeof(slot->name), "%s", name);
    snprintf(slot->expansion, sizeof(slot->expansion), "%s", expansion);
    return ALIAS_SET_OK;
}

bool alias_unset(struct alias_table *t, const char *name) {
    name = strip_slash(name);
    if (!t || !name) return false;
    for (size_t i = 0; i < t->count; i++) {
        if (strcasecmp(t->entries[i].name, name) == 0) {
            memmove(t->entries + i, t->entries + i + 1,
                    sizeof(t->entries[0]) * (t->count - i - 1));
            t->count--;
            return true;
        }
    }
    return false;
}

const char *alias_get(const struct alias_table *t, const char *name) {
    name = strip_slash(name);
    if (!t || !name) return NULL;
    for (size_t i = 0; i < t->count; i++)
        if (strcasecmp(t->entries[i].name, name) == 0) return t->entries[i].expansion;
    return NULL;
}

bool alias_expand_once(const struct alias_table *t, const char *line, char *out, size_t out_sz) {
    if (!t || !line || !out || out_sz == 0) return false;
    if (line[0] != '/') return false;

    char verb[ALIAS_MAX_NAME];
    const char *sp = strchr(line + 1, ' ');
    size_t vlen = sp ? (size_t)(sp - line - 1) : strlen(line + 1);
    if (vlen == 0 || vlen >= sizeof(verb)) return false;
    memcpy(verb, line + 1, vlen);
    verb[vlen] = '\0';

    /* Built-ins always win — checked BEFORE the table so a stale alias
     * cannot capture a verb that later became built-in. */
    if (alias_is_builtin(verb)) return false;
    const char *expansion = alias_get(t, verb);
    if (!expansion) return false;

    const char *args = sp ? sp + 1 : "";
    while (*args == ' ') args++;

    /* Positional split for $1..$9. Done on a copy: `args` still points at
     * the caller's line and is needed intact for $*. */
    char argbuf[ALIAS_MAX_EXPANSION];
    snprintf(argbuf, sizeof(argbuf), "%s", args);
    const char *tokens[9] = {0};
    size_t ntok = 0;
    for (char *p = argbuf; *p && ntok < 9;) {
        while (*p == ' ') p++;
        if (!*p) break;
        tokens[ntok++] = p;
        while (*p && *p != ' ') p++;
        if (*p) *p++ = '\0';
    }

    size_t w = 0;
    bool used_placeholder = false;
    for (const char *p = expansion; *p && w + 1 < out_sz;) {
        if (*p == '$' && p[1] >= '1' && p[1] <= '9') {
            used_placeholder = true;
            size_t idx = (size_t)(p[1] - '1');
            const char *val = idx < ntok ? tokens[idx] : "";
            int n = snprintf(out + w, out_sz - w, "%s", val);
            if (n > 0 && (size_t)n < out_sz - w) w += (size_t)n;
            p += 2;
        } else if (*p == '$' && p[1] == '*') {
            used_placeholder = true;
            int n = snprintf(out + w, out_sz - w, "%s", args);
            if (n > 0 && (size_t)n < out_sz - w) w += (size_t)n;
            p += 2;
        } else {
            out[w++] = *p++;
        }
    }
    out[w] = '\0';

    /* No placeholder anywhere: append the arguments, so
     * `/alias hi /me waves at` + `/hi bob` reads as intended rather than
     * silently discarding "bob". */
    if (!used_placeholder && *args) {
        size_t n = strlen(out);
        if (n + 1 < out_sz) snprintf(out + n, out_sz - n, " %s", args);
    }
    return true;
}

int alias_expand(const struct alias_table *t, const char *line, char *out, size_t out_sz) {
    if (!out || out_sz == 0) return 0;
    snprintf(out, out_sz, "%s", line ? line : "");
    char scratch[ALIAS_MAX_EXPANSION];
    int applied = 0;
    for (; applied < ALIAS_MAX_DEPTH; applied++) {
        if (!alias_expand_once(t, out, scratch, sizeof(scratch))) break;
        snprintf(out, out_sz, "%s", scratch);
    }
    return applied;
}
