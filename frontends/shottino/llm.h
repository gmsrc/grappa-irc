/* llm — talking to a language model, as data.
 *
 * Two backends, one shape:
 *
 *   OPENAI      an OpenAI-compatible HTTP endpoint (url + token + model).
 *   CLAUDE_CLI  a LOCAL `claude` binary driven headless over pipes. No
 *               network of ours, no API key in our config, and NO config
 *               of ours either: it runs under the user's own claude
 *               configuration, exactly as if they had typed the command.
 *               Every shottino on the machine therefore shares one
 *               login, which is what the user already expects of it.
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
/* Big enough for an AGENT.md plus a handful of memory notes: the
 * EFFECTIVE prompt is assembled per request and can dwarf a hand-typed
 * one. It is never serialised back — what is saved is what the user set. */
#define LLM_MAX_PROMPT 16384
#define LLM_MAX_PATH 512
#define LLM_MAX_TOOLS 256

typedef enum {
    LLM_BACKEND_OPENAI = 0,
    LLM_BACKEND_CLAUDE_CLI
} llm_backend;

struct llm_config {
    llm_backend backend;
    char url[LLM_MAX_URL];     /* openai: base, e.g. https://api.openai.com/v1 */
    char token[LLM_MAX_TOKEN]; /* openai: bearer. NEVER rendered unredacted. */
    char model[LLM_MAX_MODEL];
    char prompt[LLM_MAX_PROMPT]; /* system prompt */
    /* claude-cli: which of the CLI's OWN built-in tools to enable, as
     * the CLI names them (e.g. "Read,WebSearch"). Empty — the default —
     * means `--tools ''`: none at all, ours over MCP being the only ones
     * it has. These run INSIDE the CLI and never reach shottino's
     * approval gate, which is why "none" is the default and why the
     * setter says so out loud. */
    char cli_tools[LLM_MAX_TOOLS];
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
 * only (the binary and its credentials are the user's own).
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

/* ── Tools ─────────────────────────────────────────────────────────────
 *
 * The definitions are DATA and live here, so the schema the model sees
 * is testable without a socket; the handlers live in shottino.c, where
 * the app state is. A tool whose schema and whose handler disagree fails
 * at the far end — inside a model's reasoning — which is the least
 * debuggable place in the system.
 */
typedef enum {
    LLM_TOOL_READ_SCROLLBACK = 0,
    LLM_TOOL_LIST_WINDOWS,
    LLM_TOOL_NAMES,
    /* Everything below WRITES to the network — see the trust model. */
    LLM_TOOL_SEND,
    LLM_TOOL_JOIN,
    LLM_TOOL_PART,
    LLM_TOOL_CTCP,
    /* Writes to DISK, not to the network — and it is gated like a write
     * for a sharper reason than the others: a memory is re-read as
     * context on every later turn, so a note somebody talks the bot into
     * keeping is influence that OUTLIVES the conversation that planted
     * it. Of everything here it is the only tool whose effect is
     * permanent. */
    LLM_TOOL_REMEMBER,
    LLM_TOOL__COUNT
} llm_tool_id;

struct llm_tool_def {
    const char *name;
    bool writes; /* drives the approval gate; read tools never prompt */
    const char *description;
    const char *params; /* JSON Schema for the arguments object */
};

const struct llm_tool_def *llm_tool(llm_tool_id id);
const struct llm_tool_def *llm_tool_by_name(const char *name);

/* The `tools` array for a chat/completions body. Caller frees. When
 * `writes_allowed` is false the WRITE tools are omitted ENTIRELY rather
 * than advertised-and-refused: a tool the model cannot see is a tool it
 * cannot be argued into trying. */
char *llm_tools_json(bool writes_allowed);

/* One parsed tool call from a response. */
struct llm_tool_call {
    char id[128];
    char name[64];
    char arguments[1024]; /* raw JSON object, as the model sent it */
};

/* Pull tool_calls out of an OpenAI response. Returns how many were
 * written (bounded by `max`). Zero means the model answered with text
 * instead, which is the normal case. */
size_t llm_parse_tool_calls(const json_value *root, struct llm_tool_call *out, size_t max);

/* ── Tools on the claude CLI: the MCP shim ─────────────────────────────
 *
 * `claude -p --tools ''` is not a limitation we can flag our way out of:
 * --tools selects BUILT-IN tools by NAME, and no flag registers a
 * function definition. MCP is the only injection point the CLI has, so
 * the tools reach it as an MCP server — which shottino serves itself,
 * re-executing its own binary as `shottino --mcp-shim`. One tool table,
 * two transports; a second definition of the same tools in a second
 * shape is a schema that drifts.
 *
 * The shim ADVERTISES and never executes. Executing would put the tool
 * on the far side of a pipe from the app state and the approval gate,
 * where nothing can ask the owner anything. Instead the caller stops the
 * CLI the moment a tool_use block completes, runs the tool HERE under
 * the gate, and re-prompts with the result — which is also how the
 * openai path works, so there is one tool story and not two.
 *
 * (Learned from aisbf's claude provider, which solved this first.)
 */
#define LLM_MCP_SERVER "shottino"
#define LLM_MCP_PREFIX "mcp__" LLM_MCP_SERVER "__"

/* The CLI namespaces MCP tools; our handlers know the bare name. */
const char *llm_mcp_strip_prefix(const char *name);

/* The `tools` array in MCP tools/list shape (name/description/
 * inputSchema), same allowlist rule as llm_tools_json. Caller frees. */
char *llm_tools_mcp_json(bool writes_allowed);

/* One line of JSON-RPC in, one line out. Returns false when no response
 * is owed (a notification, or unparseable input) — the shim must stay
 * silent then, not answer with an error to a request nobody made.
 * `tools_json` is the tools/list array, spliced in verbatim. */
bool llm_mcp_response(const char *line, const char *tools_json, char *out, size_t out_sz);

/* ── Reading the CLI's stream ──────────────────────────────────────────
 *
 * Accumulates one turn: text deltas, and any tool_use blocks the model
 * emits through the shim. `--include-partial-messages` is what makes
 * both arrive — the arguments come as input_json_delta fragments keyed
 * by content-block index, and `stop_reason` on message_delta is the only
 * reliable marker that EVERY tool_use in the turn has landed. Stopping
 * at the first one loses a parallel call. */
#define LLM_MAX_TOOL_CALLS 4

struct llm_claude_stream {
    char *text; /* borrowed, NUL-terminated as it fills */
    size_t text_sz;
    size_t used;
    bool done;
    bool saw_delta_text; /* deltas win; the assistant echo is the same words */
    struct llm_tool_call calls[LLM_MAX_TOOL_CALLS];
    long block_of[LLM_MAX_TOOL_CALLS]; /* content-block index per call */
    size_t ncalls;
};

void llm_claude_stream_init(struct llm_claude_stream *st, char *buf, size_t buf_sz);

/* Returns false when the line is not JSON we recognise — normal, not an
 * error: the stream carries frames we do not consume. */
bool llm_claude_stream_feed(struct llm_claude_stream *st, const char *line);

/* ── The /bot trust model (agreed 2026-08-01) ──────────────────────────
 *
 * Recorded HERE rather than in a plan, because every function that
 * touches a tool has to obey it and a plan is not compiled.
 *
 * 1. NETWORK TEXT IS DATA, NEVER INSTRUCTION. Anything arriving from
 *    IRC reaches the model as quoted, attributed content. The only
 *    unconditional instruction channel is the local input line, which
 *    nobody on the network can reach.
 *
 * 1b. THE OWNER IS AN IDENTITY, NOT A NICK. `bot.owner` names who may
 *    direct the bot from the network, and a sender matches it only when
 *    BOTH hold:
 *      * they are on the SAME grappa (this client's own session, or a
 *        session of the same subject) — not merely someone using that
 *        nick on the network; and
 *      * they are AUTHENTICATED to the ircd (NickServ), verified from
 *        the WHOIS `account` / registered flags rather than assumed.
 *    A bare nick match is NOT sufficient and must never be treated as
 *    one: `nextime_` is one keystroke from `nextime`, and a nick freed
 *    by a netsplit is anybody's for the taking. When the check cannot be
 *    completed — no WHOIS answer, services down — the sender is NOT the
 *    owner, and the bot falls back to being driven ONLY by this
 *    shottino's own input line. Failing closed to local-only is the
 *    single safe direction: an unverifiable owner is indistinguishable
 *    from an impostor, and the impostor is the one who benefits from a
 *    guess.
 *
 * 2. READ tools (scrollback, names) are available whenever the bot runs.
 *    WRITE tools (send, join, part, ctcp) are not.
 *
 * 3. A WRITE requested on behalf of somebody else ASKS THE OWNER INLINE
 *    — approve once / approve always for this person and this tool /
 *    deny — UNLESS the owner has already pre-approved that (person,
 *    tool) pair. The grant is per PAIR: approving alice for `send` does
 *    not approve her for `join`, and approving her today does not
 *    approve bob.
 *
 * 4. The owner's own typed instructions execute without a prompt. They
 *    came from the keyboard, which is the trusted channel by definition.
 *
 * 5. /exec, /quote and the operator verbs are NEVER exposed as tools, at
 *    any approval level. A tool the model cannot reach is the only kind
 *    that cannot be talked into being reached.
 *
 * The system prompt is mitigation, not containment: a model can be
 * argued into anything. What actually contains it is this list — the
 * tool allowlist, the per-pair grant, and the rate limit.
 */

#endif /* SHOTTINO_LLM_H */
