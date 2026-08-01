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

TEST(a_write_tool_is_omitted_entirely_when_writes_are_not_allowed) {
    char *read_only = llm_tools_json(false);
    CHECK(read_only != NULL);
    if (!read_only) return;
    /* Read tools are offered... */
    CHECK(strstr(read_only, "read_scrollback") != NULL);
    CHECK(strstr(read_only, "list_windows") != NULL);
    /* ...and the write tools are not even NAMED. Advertising a tool and
     * refusing it invites a model to argue; one it cannot see, it cannot
     * try. */
    CHECK(strstr(read_only, "send_message") == NULL);
    CHECK(strstr(read_only, "join_channel") == NULL);
    CHECK(strstr(read_only, "part_channel") == NULL);
    CHECK(strstr(read_only, "send_ctcp") == NULL);
    free(read_only);

    char *full = llm_tools_json(true);
    CHECK(full != NULL);
    if (!full) return;
    CHECK(strstr(full, "send_message") != NULL);
    CHECK(strstr(full, "join_channel") != NULL);
    free(full);
}

TEST(the_tools_array_is_valid_json_the_endpoint_will_accept) {
    /* A schema that does not parse is a 400 with no useful diagnostic,
     * and the feature simply "does not work". */
    for (int allowed = 0; allowed < 2; allowed++) {
        char *tools = llm_tools_json(allowed != 0);
        CHECK(tools != NULL);
        if (!tools) continue;
        json_doc *doc = json_parse(tools, strlen(tools), NULL, 0);
        CHECK(doc != NULL);
        if (doc) {
            /* Every entry carries the function shape the API requires. */
            const json_value *first = json_at(json_root(doc), 0);
            CHECK_STR(json_string(json_get(first, "type")), "function");
            const json_value *fn = json_get(first, "function");
            CHECK(json_string(json_get(fn, "name")) != NULL);
            CHECK(json_get(fn, "parameters") != NULL);
            json_free(doc);
        }
        free(tools);
    }
}

TEST(every_tool_is_findable_by_the_name_the_model_will_send_back) {
    for (int i = 0; i < LLM_TOOL__COUNT; i++) {
        const struct llm_tool_def *d = llm_tool((llm_tool_id)i);
        CHECK(d != NULL);
        if (!d) continue;
        /* The round trip that matters: the schema advertises `name`, the
         * model echoes `name`, and the handler is looked up BY name. A
         * definition that cannot be found by its own name is a tool that
         * silently never runs. */
        CHECK(llm_tool_by_name(d->name) == d);
    }
    CHECK(llm_tool_by_name("no_such_tool") == NULL);
    CHECK(llm_tool_by_name(NULL) == NULL);
    /* /exec, /quote and the oper verbs are NOT tools, at any level. */
    CHECK(llm_tool_by_name("exec") == NULL);
    CHECK(llm_tool_by_name("quote") == NULL);
    CHECK(llm_tool_by_name("kill") == NULL);
}

TEST(tool_calls_are_read_out_of_the_response) {
    const char *json =
        "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":null,"
        "\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":"
        "{\"name\":\"send_message\","
        "\"arguments\":\"{\\\"target\\\":\\\"#sniffo\\\",\\\"text\\\":\\\"hi\\\"}\"}}]}}]}";
    json_doc *doc = json_parse(json, strlen(json), NULL, 0);
    CHECK(doc != NULL);
    if (!doc) return;
    struct llm_tool_call calls[4];
    size_t n = llm_parse_tool_calls(json_root(doc), calls, 4);
    CHECK_LONG(n, 1);
    CHECK_STR(calls[0].id, "call_1");
    CHECK_STR(calls[0].name, "send_message");
    /* `arguments` is a STRING carrying JSON, not an object — passed
     * through verbatim so a schema change needs no change here. */
    CHECK_STR(calls[0].arguments, "{\"target\":\"#sniffo\",\"text\":\"hi\"}");
    json_free(doc);

    /* A plain text answer has no tool calls, and that is the normal
     * case — not an error. */
    const char *plain = "{\"choices\":[{\"message\":{\"content\":\"just talking\"}}]}";
    doc = json_parse(plain, strlen(plain), NULL, 0);
    CHECK(doc != NULL);
    if (doc) {
        CHECK_LONG(llm_parse_tool_calls(json_root(doc), calls, 4), 0);
        json_free(doc);
    }
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
    RUN(a_write_tool_is_omitted_entirely_when_writes_are_not_allowed);
    RUN(the_tools_array_is_valid_json_the_endpoint_will_accept);
    RUN(every_tool_is_findable_by_the_name_the_model_will_send_back);
    RUN(tool_calls_are_read_out_of_the_response);
    return test_report();
}
