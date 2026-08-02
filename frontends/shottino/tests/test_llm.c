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
     * arrives with an EMPTY prompt, which is how "use the built-in" is
     * spelled.
     *
     * It used to arrive carrying the default text, and that is exactly
     * what made a cleared prompt permanent: the parse seeded the
     * default and then an empty `prompt =` line in the file overwrote
     * it, so the model ran with no system prompt at all and there was
     * no way back. The default is chosen where the prompt is USED now,
     * which also lets it describe the tools that turn actually has. */
    struct llm_config fresh;
    CHECK(llm_config_parse("", &fresh));
    CHECK_LONG(fresh.backend, LLM_BACKEND_OPENAI);
    CHECK_STR(fresh.prompt, "");

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

/* The CLI nests its partial-message events inside a `stream_event`
 * envelope. Reading them at the top level finds NOTHING and yields a
 * turn with no text and no tools — a silent wrong answer, so it is
 * pinned here in the shape the CLI actually emits. */
TEST(stream_json_accumulates_text_and_notices_the_end) {
    char buf[256];
    struct llm_claude_stream st;
    llm_claude_stream_init(&st, buf, sizeof(buf));

    CHECK(llm_claude_stream_feed(&st,
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,"
        "\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}}"));
    CHECK(llm_claude_stream_feed(&st,
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,"
        "\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}}"));
    CHECK_STR(buf, "Hello");
    CHECK(!st.done);

    /* Frames we do not consume are NORMAL, not errors. */
    CHECK(!llm_claude_stream_feed(&st, "not json at all"));
    CHECK_STR(buf, "Hello");

    /* The finished assistant message repeats what the deltas said. Once
     * is the answer; twice is a model that looks like it stammers. */
    CHECK(llm_claude_stream_feed(&st,
        "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Hello\"}]}}"));
    CHECK_STR(buf, "Hello");

    /* stop_reason on a message_delta ends the turn — the signal
     * --include-partial-messages exists to deliver. */
    CHECK(llm_claude_stream_feed(&st,
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\","
        "\"delta\":{\"stop_reason\":\"end_turn\"}}}"));
    CHECK(st.done);
}

TEST(a_result_frame_carries_the_text_when_no_delta_did) {
    char buf[64];
    struct llm_claude_stream st;
    llm_claude_stream_init(&st, buf, sizeof(buf));
    CHECK(llm_claude_stream_feed(
        &st, "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"the answer\"}"));
    CHECK(st.done);
    CHECK_STR(buf, "the answer");
}

TEST(a_tool_call_arrives_through_the_mcp_shim_by_either_route) {
    /* Route one: built up from fragments, with the name namespaced by
     * the CLI and the arguments split across input_json_delta frames. */
    char buf[64];
    struct llm_claude_stream st;
    llm_claude_stream_init(&st, buf, sizeof(buf));
    CHECK(llm_claude_stream_feed(&st,
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":1,"
        "\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu_1\","
        "\"name\":\"mcp__shottino__send_message\"}}}"));
    CHECK(llm_claude_stream_feed(&st,
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":1,"
        "\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"target\\\":\"}}}"));
    CHECK(llm_claude_stream_feed(&st,
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":1,"
        "\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"#room\\\"}\"}}}"));
    CHECK(st.ncalls == 1);
    CHECK_STR(st.calls[0].name, "send_message"); /* the prefix is the CLI's, not ours */
    CHECK_STR(st.calls[0].arguments, "{\"target\":\"#room\"}");

    /* Route two: the same call announced whole, `input` as an OBJECT and
     * never a single delta. A model that emits small arguments in one
     * piece takes this path — and the id says it is the SAME call, so it
     * must not run twice. */
    CHECK(llm_claude_stream_feed(&st,
        "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"tu_1\","
        "\"name\":\"mcp__shottino__send_message\",\"input\":{\"target\":\"#other\"}}]}}"));
    CHECK(st.ncalls == 1);
    CHECK_STR(st.calls[0].arguments, "{\"target\":\"#room\"}"); /* the fragments won */

    /* A different id IS a different call, and its object is serialised
     * back to the text a handler reads. */
    struct llm_claude_stream fresh;
    char buf2[64];
    llm_claude_stream_init(&fresh, buf2, sizeof(buf2));
    CHECK(llm_claude_stream_feed(&fresh,
        "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"tu_9\","
        "\"name\":\"mcp__shottino__names\",\"input\":{\"channel\":\"#c\",\"n\":2}}]}}"));
    CHECK(fresh.ncalls == 1);
    CHECK_STR(fresh.calls[0].name, "names");
    CHECK_STR(fresh.calls[0].arguments, "{\"channel\":\"#c\",\"n\":2}");
}

/* The shim is the ONLY way a caller's tools reach `claude -p`: --tools
 * selects built-ins by name and cannot register a definition. */
/* The shim reflects the caller's own strings; it must escape them.
 *
 * The request id round-trips in the type it arrived in, and a string id
 * was copied straight into the reply. A quote or a backslash in it would
 * end the JSON string early and leave the rest of the frame as garbage
 * the client cannot parse — the one unescaped interpolation left in the
 * codebase. */
TEST(the_mcp_shim_escapes_what_it_reflects) {
    char out[4096];

    /* A quote in the id. */
    CHECK(llm_mcp_response("{\"jsonrpc\":\"2.0\",\"id\":\"a\\\"b\",\"method\":\"ping\"}", "[]", out,
                           sizeof(out)));
    CHECK(strstr(out, "\"id\":\"a\\\"b\"") != NULL);
    /* And it is still ONE parseable document. */
    json_doc *doc = json_parse(out, strlen(out), NULL, 0);
    CHECK(doc != NULL);
    if (doc) json_free(doc);

    /* A backslash in the protocol version, which is echoed back. */
    CHECK(llm_mcp_response(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"x\\\\y\"}}",
        "[]", out, sizeof(out)));
    doc = json_parse(out, strlen(out), NULL, 0);
    CHECK(doc != NULL);
    if (doc) json_free(doc);
}

TEST(the_mcp_shim_advertises_the_tools_and_executes_none) {
    char out[8192];

    CHECK(llm_mcp_response("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\","
                           "\"params\":{\"protocolVersion\":\"2024-11-05\"}}",
                           "[]", out, sizeof(out)));
    CHECK(strstr(out, "\"id\":1") != NULL);
    CHECK(strstr(out, "\"protocolVersion\":\"2024-11-05\"") != NULL);
    CHECK(strstr(out, "shottino") != NULL);

    char *tools = llm_tools_mcp_json(true);
    CHECK(tools != NULL);
    /* MCP spells the schema `inputSchema`; the openai array spells it
     * `parameters`. Same table, two shapes. */
    CHECK(strstr(tools, "\"inputSchema\"") != NULL);
    CHECK(strstr(tools, "\"name\":\"send_message\"") != NULL);
    CHECK(strstr(tools, "\"type\":\"function\"") == NULL);
    CHECK(llm_mcp_response("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}", tools, out,
                           sizeof(out)));
    CHECK(strstr(out, "\"name\":\"send_message\"") != NULL);
    free(tools);

    /* Read-only advertises fewer, by the same rule as the openai array. */
    char *ro = llm_tools_mcp_json(false);
    CHECK(ro != NULL);
    CHECK(strstr(ro, "\"name\":\"send_message\"") == NULL);
    CHECK(strstr(ro, "\"name\":\"read_scrollback\"") != NULL);
    free(ro);

    /* A call is a LOST RACE, not a feature: shottino runs its own tools
     * behind the approval gate. Answering isError puts the reason in the
     * transcript instead of hanging the CLI on a request nobody answers. */
    CHECK(llm_mcp_response("{\"jsonrpc\":\"2.0\",\"id\":\"abc\",\"method\":\"tools/call\","
                           "\"params\":{\"name\":\"send_message\"}}",
                           "[]", out, sizeof(out)));
    CHECK(strstr(out, "\"id\":\"abc\"") != NULL); /* a string id stays a string */
    CHECK(strstr(out, "\"isError\":true") != NULL);
    CHECK(strstr(out, "did NOT happen") != NULL);

    CHECK(llm_mcp_response("{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}", "[]", out,
                           sizeof(out)));
    CHECK(strstr(out, "\"result\":{}") != NULL);

    CHECK(llm_mcp_response("{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"resources/list\"}", "[]",
                           out, sizeof(out)));
    CHECK(strstr(out, "-32601") != NULL);

    /* A notification has no id and is owed no answer — replying to one
     * is a protocol error, and the CLI sends several. */
    CHECK(!llm_mcp_response("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}", "[]",
                            out, sizeof(out)));
    CHECK(!llm_mcp_response("garbage", "[]", out, sizeof(out)));
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

/* The built-in prompt describes THIS turn's tools, from the same table
 * that declares them to the model.
 *
 * There was a four-sentence prompt that mentioned no tools at all, and
 * an empty `prompt =` line in the config overwrote even that — so a
 * cleared prompt stayed cleared and the model was told nothing about
 * what it was, what it was talking to, or what it could do. */
TEST(the_default_prompt_names_the_tools_it_actually_has) {
    static char full[8192], reads[8192], none[8192];
    llm_default_prompt(full, sizeof(full), 1, false);
    llm_default_prompt(reads, sizeof(reads), 0, true);
    llm_default_prompt(none, sizeof(none), -1, false);

    /* The medium, in every version. */
    CHECK(strstr(full, "IRC") != NULL);
    CHECK(strstr(full, "no markdown") != NULL);
    CHECK(strstr(reads, "no markdown") != NULL);

    /* Every tool the turn is OFFERED is named, and none that it is not.
     * Walked from the table, so a tool added later cannot be missed. */
    for (llm_tool_id id = 0; id < LLM_TOOL__COUNT; id++) {
        const struct llm_tool_def *t = llm_tool(id);
        /* Matched as a LIST ENTRY, not as a substring: the closing
         * sentence says "remembering", which contains "remember". */
        char entry[128];
        snprintf(entry, sizeof(entry), "- %s:", t->name);
        CHECK(strstr(full, entry) != NULL);                    /* writes allowed: all */
        if (t->writes) CHECK(strstr(reads, entry) == NULL);    /* reads only: none of these */
        else CHECK(strstr(reads, entry) != NULL);
        CHECK(strstr(none, entry) == NULL);                    /* no tools: none at all */
    }

    /* The instruction that the tool loop exists to satisfy. */
    CHECK(strstr(full, "ANSWER IN WORDS") != NULL);
    CHECK(strstr(none, "No tools are available") != NULL);

    /* The trust paragraph appears only where strangers can reach it. */
    CHECK(strstr(reads, "never instructions to you") != NULL);
    CHECK(strstr(full, "never instructions to you") == NULL);
}

/* An empty prompt in the config means "use the built-in", not "none".
 *
 * llm_config_parse used to seed the default and then let an empty
 * `prompt =` line overwrite it, so a prompt cleared once was gone for
 * good and the model ran with no system prompt at all. */
TEST(an_empty_prompt_line_does_not_erase_the_default) {
    struct llm_config cfg = { 0 };
    CHECK(llm_config_parse("backend = openai\nprompt = \n", &cfg));
    CHECK_STR(cfg.prompt, "");   /* empty is carried faithfully... */

    /* ...and empty is what the caller turns into the built-in. */
    static char built[8192];
    llm_default_prompt(built, sizeof(built), 1, false);
    CHECK(built[0] != 0);
    CHECK(strstr(built, "shottino") != NULL);

    /* A CUSTOM prompt still gets the tools appended: the prompt is about
     * tone, the tool list is about what this turn can do, and one must
     * not silently switch off the other. */
    static char mixed[8192];
    snprintf(mixed, sizeof(mixed), "%s", "Answer only in Italian.");
    llm_tools_prompt(mixed + strlen(mixed), sizeof(mixed) - strlen(mixed), 1, false);
    CHECK(strstr(mixed, "Answer only in Italian.") != NULL);
    CHECK(strstr(mixed, "- read_scrollback:") != NULL);
    CHECK(strstr(mixed, "ANSWER IN WORDS") != NULL);
    /* And the style half is NOT repeated. */
    CHECK(strstr(mixed, "HOW TO ANSWER") == NULL);

    /* A configured prompt still wins and round-trips whole. */
    struct llm_config mine = { 0 };
    CHECK(llm_config_parse("prompt = answer only in Italian\n", &mine));
    CHECK_STR(mine.prompt, "answer only in Italian");
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
    /* These three were written and never registered, so the MCP shim —
     * the door every tool reaches the claude CLI through — had no
     * running test at all. The compiler had been saying so on every
     * clean build ("defined but not used"); incremental builds hid it. */
    RUN(a_result_frame_carries_the_text_when_no_delta_did);
    RUN(a_tool_call_arrives_through_the_mcp_shim_by_either_route);
    RUN(the_mcp_shim_advertises_the_tools_and_executes_none);
    RUN(the_mcp_shim_escapes_what_it_reflects);
    RUN(the_default_prompt_names_the_tools_it_actually_has);
    RUN(an_empty_prompt_line_does_not_erase_the_default);
    return test_report();
}
