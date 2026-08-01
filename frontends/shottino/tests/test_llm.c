/* test_llm — the parts that fail silently on the wire.
 *
 * A wrong key in a request body does not crash: the endpoint returns an
 * error nobody reads, or worse accepts it and ignores the field. A wrong
 * envelope shape on the CLI's stdin does not crash either — the
 * subprocess simply sits there reading forever. Neither shows up as a
 * failure anywhere except "the feature does nothing", which is the
 * hardest kind of bug to chase and the reason this module is pure.
 */
#include "../llm.h"

#include "test.h"

#include <stdlib.h>
#include <string.h>

TEST(config_round_trips_and_survives_a_bad_line) {
    struct llm_config c;
    const char *text =
        "# a comment\n"
        "backend = claude-cli\n"
        "model=claude-sonnet-4\n"
        "  url  =  https://api.example/v1  \n"
        "this line has no equals sign and must not be fatal\n"
        "future_key = something an older build has never heard of\n"
        "prompt = line one\\nline two\n";
    CHECK(llm_config_parse(text, &c));
    CHECK_LONG(c.backend, LLM_BACKEND_CLAUDE_CLI);
    CHECK_STR(c.model, "claude-sonnet-4");
    /* Whitespace around both key and value is trimmed. */
    CHECK_STR(c.url, "https://api.example/v1");
    /* `\n` in the file is a real newline in the prompt. */
    CHECK_STR(c.prompt, "line one\nline two");

    /* An empty config is not an error — it is a fresh install, and it
     * arrives carrying the default prompt rather than nothing. */
    struct llm_config fresh;
    CHECK(llm_config_parse("", &fresh));
    CHECK_LONG(fresh.backend, LLM_BACKEND_OPENAI);
    CHECK_STR(fresh.prompt, llm_default_prompt());

    /* Serialise → parse gets the same struct back, newlines included. */
    char buf[8192];
    CHECK(llm_config_serialize(&c, buf, sizeof(buf)));
    struct llm_config again;
    CHECK(llm_config_parse(buf, &again));
    CHECK_LONG(again.backend, c.backend);
    CHECK_STR(again.model, c.model);
    CHECK_STR(again.url, c.url);
    CHECK_STR(again.prompt, c.prompt);
}

TEST(readiness_says_which_field_is_missing) {
    struct llm_config c;
    const char *why = NULL;

    llm_config_parse("backend = openai\n", &c);
    CHECK(!llm_config_ready(&c, &why));
    CHECK(why && strstr(why, "url") != NULL);

    llm_config_parse("backend = openai\nurl = https://x/v1\n", &c);
    CHECK(!llm_config_ready(&c, &why));
    CHECK(why && strstr(why, "model") != NULL);

    llm_config_parse("backend = openai\nurl = https://x/v1\nmodel = m\n", &c);
    CHECK(!llm_config_ready(&c, &why));
    CHECK(why && strstr(why, "token") != NULL);

    llm_config_parse("backend = openai\nurl = https://x/v1\nmodel = m\ntoken = t\n", &c);
    CHECK(llm_config_ready(&c, &why));

    /* claude-cli needs NEITHER url nor token: the binary owns its own
     * credentials in CLAUDE_CONFIG_DIR, which is the point of it. */
    llm_config_parse("backend = claude-cli\n", &c);
    CHECK(llm_config_ready(&c, &why));
}

TEST(a_token_is_never_shown_not_even_its_length) {
    char out[64];
    llm_token_redacted("sk-averyverylongsecrettoken", out, sizeof(out));
    CHECK_STR(out, "********");
    /* A short secret masks IDENTICALLY — otherwise the panel leaks the
     * length of the thing it is hiding. */
    llm_token_redacted("x", out, sizeof(out));
    CHECK_STR(out, "********");
    llm_token_redacted("", out, sizeof(out));
    CHECK_STR(out, "(unset)");
}

TEST(the_openai_body_puts_the_system_prompt_first) {
    struct llm_config c;
    llm_config_parse("backend = openai\nmodel = gpt-4o-mini\nprompt = be brief\n", &c);
    struct llm_turn turns[] = {
        { "user", "hello" },
        { "assistant", "hi" },
        { "user", "and now?" },
    };
    char *body = llm_openai_body(&c, turns, 3);
    CHECK(body != NULL);
    if (!body) return;
    CHECK_STR(body,
              "{\"model\":\"gpt-4o-mini\",\"messages\":["
              "{\"role\":\"system\",\"content\":\"be brief\"},"
              "{\"role\":\"user\",\"content\":\"hello\"},"
              "{\"role\":\"assistant\",\"content\":\"hi\"},"
              "{\"role\":\"user\",\"content\":\"and now?\"}]}");
    free(body);
}

TEST(a_body_escapes_what_would_otherwise_break_it) {
    struct llm_config c;
    llm_config_parse("backend = openai\nmodel = m\nprompt = p\n", &c);
    /* A quote, a backslash, a newline and a control character are each a
     * body the endpoint rejects if they go through raw — and the user
     * types all of them. */
    struct llm_turn turns[] = {
        { "user", "say \"hi\"\\ now\nplease\x01" },
    };
    char *body = llm_openai_body(&c, turns, 1);
    CHECK(body != NULL);
    if (!body) return;
    CHECK(strstr(body, "\\\"hi\\\"") != NULL);
    CHECK(strstr(body, "\\\\ now") != NULL);
    CHECK(strstr(body, "\\nplease") != NULL);
    CHECK(strstr(body, "\\u0001") != NULL);
    /* And the result is parseable JSON, which is the actual contract. */
    json_doc *doc = json_parse(body, strlen(body), NULL, 0);
    CHECK(doc != NULL);
    if (doc) json_free(doc);
    free(body);
}

TEST(the_reply_is_read_out_of_the_response_shape) {
    const char *ok = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"42\"}}]}";
    json_doc *doc = json_parse(ok, strlen(ok), NULL, 0);
    CHECK(doc != NULL);
    CHECK_STR(llm_openai_reply(json_root(doc)), "42");
    json_free(doc);

    /* An error response has no choices — that must read as "no reply",
     * not as a crash. */
    const char *err = "{\"error\":{\"message\":\"nope\"}}";
    doc = json_parse(err, strlen(err), NULL, 0);
    CHECK(doc != NULL);
    CHECK(llm_openai_reply(json_root(doc)) == NULL);
    json_free(doc);
}

TEST(the_claude_stdin_frame_is_the_envelope_the_cli_reads) {
    /* In --input-format stream-json the positional prompt is IGNORED, so
     * this frame IS the prompt. Wrong shape = a subprocess that reads
     * forever and a /llm that hangs. */
    char *f = llm_claude_stdin_frame("hello \"world\"");
    CHECK(f != NULL);
    if (!f) return;
    CHECK_STR(f,
              "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":"
              "[{\"type\":\"text\",\"text\":\"hello \\\"world\\\"\"}]}}\n");
    /* Newline-terminated: the CLI reads line-framed JSON. */
    CHECK(f[strlen(f) - 1] == '\n');
    free(f);
}

TEST(stream_json_accumulates_text_and_notices_the_end) {
    char out[256] = "";
    size_t used = 0;
    bool done = false;

    CHECK(llm_claude_stream_line(
        "{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}",
        out, sizeof(out), &used, &done));
    CHECK(llm_claude_stream_line(
        "{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}",
        out, sizeof(out), &used, &done));
    CHECK_STR(out, "Hello");
    CHECK(!done);

    /* Frames we do not consume are NORMAL, not errors. */
    CHECK(!llm_claude_stream_line("not json at all", out, sizeof(out), &used, &done));
    CHECK_STR(out, "Hello");

    /* stop_reason on a message_delta ends the turn — the signal
     * --include-partial-messages exists to deliver. */
    CHECK(llm_claude_stream_line(
        "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}", out, sizeof(out),
        &used, &done));
    CHECK(done);

    /* A result frame ends it too, for the turn that carries no delta. */
    bool done2 = false;
    size_t used2 = 0;
    char out2[64] = "";
    CHECK(llm_claude_stream_line("{\"type\":\"result\",\"subtype\":\"success\"}", out2,
                                 sizeof(out2), &used2, &done2));
    CHECK(done2);
}

int main(void) {
    RUN(config_round_trips_and_survives_a_bad_line);
    RUN(readiness_says_which_field_is_missing);
    RUN(a_token_is_never_shown_not_even_its_length);
    RUN(the_openai_body_puts_the_system_prompt_first);
    RUN(a_body_escapes_what_would_otherwise_break_it);
    RUN(the_reply_is_read_out_of_the_response_shape);
    RUN(the_claude_stdin_frame_is_the_envelope_the_cli_reads);
    RUN(stream_json_accumulates_text_and_notices_the_end);
    return test_report();
}
