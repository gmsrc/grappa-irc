/* llm — talking to a language model, as data.
 *
 * Two backends, one shape:
 *
 *   OPENAI      an OpenAI-compatible HTTP endpoint (url + token + model).
 *   CLAUDE_CLI  a LOCAL `claude` binary driven headless over pipes. No
 *               network of ours, no API key in our config — the CLI owns
 *               its own credentials in CLAUDE_CONFIG_DIR.
 *
 * This module is the PURE half: config text in, config struct out;
 * request bodies built; replies and stream frames parsed. No sockets, no
 * fork, no app state — that lives in shottino.c, and this is what a test
 * can hold still. Every one of these is a place where a wrong key name
 * or a missing brace fails silently on the wire, which is exactly the
 * class of bug that has cost this client the most time.
 */
#ifndef SHOTTINO_LLM_H
#define SHOTTINO_LLM_H

#include <stdbool.h>
#include <stddef.h>

#include "json.h"

#define LLM_MAX_URL 512
#define LLM_MAX_TOKEN 512
#define LLM_MAX_MODEL 128
#define LLM_MAX_PROMPT 4096
#define LLM_MAX_PATH 512

typedef enum {
    LLM_BACKEND_OPENAI = 0,
    LLM_BACKEND_CLAUDE_CLI
} llm_backend;

struct llm_config {
    llm_backend backend;
    char url[LLM_MAX_URL];     /* openai: base, e.g. https://api.openai.com/v1 */
    char token[LLM_MAX_TOKEN]; /* openai: bearer. NEVER rendered unredacted. */
    char model[LLM_MAX_MODEL];
    char prompt[LLM_MAX_PROMPT];   /* system prompt */
    char config_dir[LLM_MAX_PATH]; /* claude-cli: CLAUDE_CONFIG_DIR */
};

/* One turn of a conversation, in the order it happened. */
struct llm_turn {
    const char *role; /* "system" | "user" | "assistant" */
    const char *content;
};

/* The prompt shipped when nothing is configured. Deliberately states the
 * medium: a model that does not know it is on IRC writes essays into a
 * channel with a 512-byte line limit. */
const char *llm_default_prompt(void);

/* `key = value` per line, `#` comments, unknown keys IGNORED (a config
 * written by a newer build must not break an older one). Returns false
 * only on a NULL argument — a malformed line is skipped, not fatal:
 * refusing to start over one bad line in a hand-editable file is worse
 * than running with the rest. */
bool llm_config_parse(const char *text, struct llm_config *out);

/* Serialise back, round-tripping what parse read. Writes the token in
 * CLEAR — this is the on-disk form, which the caller stores 0600. Never
 * use it to build anything the user sees. */
bool llm_config_serialize(const struct llm_config *cfg, char *out, size_t out_sz);

/* Is this config usable? Openai needs url+model; claude-cli needs model
 * only (the binary and its credentials live outside our config).
 * `why` receives a one-line reason when false. */
bool llm_config_ready(const struct llm_config *cfg, const char **why);

/* A token, shown. Always the same width regardless of the secret, so the
 * panel cannot leak its LENGTH either. Empty stays visibly empty. */
void llm_token_redacted(const char *token, char *out, size_t out_sz);

/* POST body for /chat/completions. Caller frees. */
char *llm_openai_body(const struct llm_config *cfg, const struct llm_turn *turns, size_t n);

/* The reply text out of an OpenAI response document, or NULL. */
const char *llm_openai_reply(const json_value *root);

/* The Anthropic envelope the CLI expects on stdin in stream-json mode —
 * the positional prompt is IGNORED there, so this frame IS the prompt.
 * Caller frees. */
char *llm_claude_stdin_frame(const char *text);

/* One line of `--output-format stream-json`. Appends any text delta to
 * `out` (bounded), and sets `*done` when the turn's stop_reason arrives.
 * Returns false when the line is not JSON we recognise — which is normal
 * and not an error: the stream carries frames we do not consume. */
bool llm_claude_stream_line(const char *line, char *out, size_t out_sz, size_t *used,
                            bool *done);

#endif /* SHOTTINO_LLM_H */
