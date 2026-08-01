#include "llm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The prompt a fresh install runs with.
 *
 * It states the MEDIUM, because a model that does not know it is on IRC
 * writes six paragraphs into a channel whose line limit is 512 bytes and
 * whose readers are looking at an 80-column terminal. */
static const char DEFAULT_PROMPT[] =
    "You are connected to an IRC network through a terminal client. "
    "Answer in plain text: no markdown, no code fences, no bullet lists. "
    "Keep replies to a few short lines — anything longer is truncated "
    "before it reaches the channel. Never invent what somebody said; if "
    "you did not see it, say so.";

const char *llm_default_prompt(void) {
    return DEFAULT_PROMPT;
}

/* ── config ─────────────────────────────────────────────────────────── */

static void set_field(char *dst, size_t dst_sz, const char *value) {
    snprintf(dst, dst_sz, "%s", value);
}

/* `\n` in a value is written escaped (a prompt is multi-line by nature
 * and the format is one key per line); this puts it back. */
static void unescape_into(char *dst, size_t dst_sz, const char *src) {
    size_t n = 0;
    for (size_t i = 0; src[i] && n + 1 < dst_sz; i++) {
        if (src[i] == '\\' && src[i + 1] == 'n') {
            dst[n++] = '\n';
            i++;
        } else if (src[i] == '\\' && src[i + 1] == '\\') {
            dst[n++] = '\\';
            i++;
        } else {
            dst[n++] = src[i];
        }
    }
    dst[n] = 0;
}

static void escape_into(char *dst, size_t dst_sz, const char *src) {
    size_t n = 0;
    for (size_t i = 0; src[i] && n + 2 < dst_sz; i++) {
        if (src[i] == '\n') {
            dst[n++] = '\\';
            dst[n++] = 'n';
        } else if (src[i] == '\\') {
            dst[n++] = '\\';
            dst[n++] = '\\';
        } else {
            dst[n++] = src[i];
        }
    }
    dst[n] = 0;
}

bool llm_config_parse(const char *text, struct llm_config *out) {
    if (!text || !out) return false;
    memset(out, 0, sizeof(*out));
    set_field(out->prompt, sizeof(out->prompt), DEFAULT_PROMPT);

    const char *p = text;
    while (*p) {
        const char *eol = strchr(p, '\n');
        size_t len = eol ? (size_t)(eol - p) : strlen(p);
        char line[LLM_MAX_PROMPT + 128];
        if (len >= sizeof(line)) len = sizeof(line) - 1;
        memcpy(line, p, len);
        line[len] = 0;
        p = eol ? eol + 1 : p + strlen(p);

        char *hash = line;
        while (*hash == ' ' || *hash == '\t') hash++;
        if (!*hash || *hash == '#') continue;
        char *eq = strchr(hash, '=');
        if (!eq) continue; /* a line without a key is not a key: skip, do not die */
        *eq = 0;
        char *key = hash;
        char *val = eq + 1;
        /* Trim both sides: `key = value` and `key=value` are the same. */
        for (char *e = key + strlen(key); e > key && (e[-1] == ' ' || e[-1] == '\t'); e--) e[-1] = 0;
        while (*val == ' ' || *val == '\t') val++;
        for (char *e = val + strlen(val); e > val && (e[-1] == ' ' || e[-1] == '\r'); e--) e[-1] = 0;

        if (strcmp(key, "backend") == 0)
            out->backend = strcmp(val, "claude-cli") == 0 ? LLM_BACKEND_CLAUDE_CLI
                                                          : LLM_BACKEND_OPENAI;
        else if (strcmp(key, "url") == 0) set_field(out->url, sizeof(out->url), val);
        else if (strcmp(key, "token") == 0) set_field(out->token, sizeof(out->token), val);
        else if (strcmp(key, "model") == 0) set_field(out->model, sizeof(out->model), val);
        else if (strcmp(key, "config_dir") == 0)
            set_field(out->config_dir, sizeof(out->config_dir), val);
        else if (strcmp(key, "prompt") == 0)
            unescape_into(out->prompt, sizeof(out->prompt), val);
        /* Anything else: ignored ON PURPOSE. A config written by a newer
         * build must not stop an older one from starting. */
    }
    return true;
}

bool llm_config_serialize(const struct llm_config *cfg, char *out, size_t out_sz) {
    if (!cfg || !out) return false;
    char prompt[LLM_MAX_PROMPT * 2];
    escape_into(prompt, sizeof(prompt), cfg->prompt);
    int n = snprintf(out, out_sz,
                     "# shottino LLM configuration. Mode 0600: the token is in CLEAR here.\n"
                     "backend = %s\n"
                     "url = %s\n"
                     "token = %s\n"
                     "model = %s\n"
                     "config_dir = %s\n"
                     "prompt = %s\n",
                     cfg->backend == LLM_BACKEND_CLAUDE_CLI ? "claude-cli" : "openai", cfg->url,
                     cfg->token, cfg->model, cfg->config_dir, prompt);
    return n > 0 && (size_t)n < out_sz;
}

bool llm_config_ready(const struct llm_config *cfg, const char **why) {
    if (!cfg) {
        if (why) *why = "no configuration";
        return false;
    }
    if (cfg->backend == LLM_BACKEND_CLAUDE_CLI) {
        /* No url and no token by design: the CLI holds its own
         * credentials in CLAUDE_CONFIG_DIR, which is the point of that
         * backend — nothing secret lands in our config file. */
        return true;
    }
    if (!cfg->url[0]) {
        if (why) *why = "no url — /llm set url https://api.openai.com/v1";
        return false;
    }
    if (!cfg->model[0]) {
        if (why) *why = "no model — /llm set model <name>";
        return false;
    }
    if (!cfg->token[0]) {
        if (why) *why = "no token — /llm set token <secret>";
        return false;
    }
    return true;
}

void llm_token_redacted(const char *token, char *out, size_t out_sz) {
    if (!out || !out_sz) return;
    /* A FIXED mask: showing a prefix, a suffix, or the length all leak
     * something about a secret that a panel has no business leaking. */
    snprintf(out, out_sz, "%s", token && token[0] ? "********" : "(unset)");
}

/* ── request bodies ─────────────────────────────────────────────────── */

/* Minimal JSON string escaper — the module builds bodies, so it cannot
 * borrow shottino.c's. Escapes what RFC 8259 requires; anything below
 * 0x20 becomes \uXXXX rather than being emitted raw (a control character
 * inside a JSON string is what makes an endpoint reject the whole body). */
static bool json_escape_into(const char *src, char *out, size_t out_sz, size_t *used) {
    size_t n = 0;
    for (const unsigned char *p = (const unsigned char *)src; *p; p++) {
        char esc[8];
        size_t len;
        switch (*p) {
        case '"': memcpy(esc, "\\\"", 2); len = 2; break;
        case '\\': memcpy(esc, "\\\\", 2); len = 2; break;
        case '\n': memcpy(esc, "\\n", 2); len = 2; break;
        case '\r': memcpy(esc, "\\r", 2); len = 2; break;
        case '\t': memcpy(esc, "\\t", 2); len = 2; break;
        default:
            if (*p < 0x20) {
                len = (size_t)snprintf(esc, sizeof(esc), "\\u%04x", *p);
            } else {
                esc[0] = (char)*p;
                len = 1;
            }
        }
        if (n + len + 1 > out_sz) return false;
        memcpy(out + n, esc, len);
        n += len;
    }
    if (n + 1 > out_sz) return false;
    out[n] = 0;
    if (used) *used = n;
    return true;
}

char *llm_openai_body(const struct llm_config *cfg, const struct llm_turn *turns, size_t n) {
    if (!cfg || (!turns && n)) return NULL;
    size_t cap = 4096;
    for (size_t i = 0; i < n; i++) cap += turns[i].content ? strlen(turns[i].content) * 2 + 64 : 64;
    cap += strlen(cfg->prompt) * 2;
    char *buf = malloc(cap);
    if (!buf) return NULL;
    char *esc = malloc(cap);
    if (!esc) {
        free(buf);
        return NULL;
    }
    size_t used = 0;
    int w = snprintf(buf, cap, "{\"model\":\"%s\",\"messages\":[", cfg->model);
    if (w < 0) goto fail;
    used = (size_t)w;

    /* The system prompt always leads, and is never taken from a turn:
     * that is the one message the operator owns. */
    if (cfg->prompt[0]) {
        if (!json_escape_into(cfg->prompt, esc, cap, NULL)) goto fail;
        w = snprintf(buf + used, cap - used, "{\"role\":\"system\",\"content\":\"%s\"}", esc);
        if (w < 0 || (size_t)w >= cap - used) goto fail;
        used += (size_t)w;
    }
    for (size_t i = 0; i < n; i++) {
        const char *role = turns[i].role ? turns[i].role : "user";
        if (!json_escape_into(turns[i].content ? turns[i].content : "", esc, cap, NULL)) goto fail;
        w = snprintf(buf + used, cap - used, "%s{\"role\":\"%s\",\"content\":\"%s\"}",
                     (used > 0 && buf[used - 1] == '}') ? "," : "", role, esc);
        if (w < 0 || (size_t)w >= cap - used) goto fail;
        used += (size_t)w;
    }
    w = snprintf(buf + used, cap - used, "]}");
    if (w < 0 || (size_t)w >= cap - used) goto fail;
    free(esc);
    return buf;

fail:
    free(esc);
    free(buf);
    return NULL;
}

const char *llm_openai_reply(const json_value *root) {
    const json_value *choices = json_get(root, "choices");
    const json_value *first = json_at(choices, 0);
    const json_value *msg = json_get(first, "message");
    return json_string(json_get(msg, "content"));
}

char *llm_claude_stdin_frame(const char *text) {
    if (!text) return NULL;
    size_t cap = strlen(text) * 2 + 256;
    char *esc = malloc(cap);
    if (!esc) return NULL;
    if (!json_escape_into(text, esc, cap, NULL)) {
        free(esc);
        return NULL;
    }
    /* The Anthropic envelope the CLI reads in --input-format stream-json.
     * The positional prompt is ignored in that mode, so THIS is the
     * prompt — getting the shape wrong means a subprocess that sits
     * there reading forever. */
    char *frame = malloc(cap + 256);
    if (!frame) {
        free(esc);
        return NULL;
    }
    snprintf(frame, cap + 256,
             "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":"
             "[{\"type\":\"text\",\"text\":\"%s\"}]}}\n",
             esc);
    free(esc);
    return frame;
}

bool llm_claude_stream_line(const char *line, char *out, size_t out_sz, size_t *used,
                            bool *done) {
    if (!line || !out || !used) return false;
    json_doc *doc = json_parse(line, strlen(line), NULL, 0);
    if (!doc) return false; /* not JSON: the stream carries chatter too */
    const json_value *root = json_root(doc);
    bool matched = false;

    /* A text delta: {"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}} */
    const json_value *delta = json_get(root, "delta");
    const char *text = json_string(json_get(delta, "text"));
    if (text) {
        size_t len = strlen(text);
        if (*used + len + 1 < out_sz) {
            memcpy(out + *used, text, len);
            *used += len;
            out[*used] = 0;
        }
        matched = true;
    }

    /* --include-partial-messages is what makes the stop_reason arrive at
     * all; it is how a tool-calling turn announces it is complete. */
    const char *type = json_string(json_get(root, "type"));
    if (type && strcmp(type, "message_delta") == 0) {
        const char *stop = json_string(json_get(delta, "stop_reason"));
        if (stop && done) *done = true;
        matched = true;
    }
    if (type && strcmp(type, "result") == 0) {
        if (done) *done = true;
        matched = true;
    }
    json_free(doc);
    return matched;
}
