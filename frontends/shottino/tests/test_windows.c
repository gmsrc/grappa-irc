/* test_windows — one window per IRC name, whatever case it arrives in.
 *
 * IRC names are case-insensitive, and this client compared them with
 * strcmp: `#Chan` and `#chan` opened two tabs, a NOTICE from `AzzuRRa`
 * opened a third beside the `azzurra` one already there, and a row whose
 * prefix disagreed with its window's spelling was filed under a scope no
 * window asked for — so it was drawn in none of them.
 *
 * The invariant this suite guards: a window is identified by its FOLDED
 * name, the fold is the ircd's (ASCII, `A-Z` only — `foo[1]` and `foo{1}`
 * stay two people), and every row files under the same canonical key its
 * window looks up.
 *
 * Like test_layout and test_commands, it compiles shottino.c itself: the
 * thing under test is app state, not a leaf module. */
#define main shottino_main_unused
#include "../shottino.c"
#undef main

#include "test.h"

static struct app *window_app(void) {
    struct app *app = calloc(1, sizeof(*app));
    if (!app) return NULL;
    pthread_mutex_init(&app->lock, NULL);
    pthread_mutex_init(&app->jobs_lock, NULL);
    pthread_cond_init(&app->jobs_cond, NULL);
    snprintf(app->subject, sizeof(app->subject), "user:vjt");
    struct network *n = &app->networks[app->network_count++];
    snprintf(n->slug, sizeof(n->slug), "azzurra");
    snprintf(n->nick, sizeof(n->nick), "vjt");
    n->id = 7;
    return app;
}

static void free_app(struct app *app) {
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    pthread_mutex_destroy(&app->lock);
    pthread_mutex_destroy(&app->jobs_lock);
    pthread_cond_destroy(&app->jobs_cond);
    free(app);
}

TEST(names_are_compared_under_the_ircds_casemapping) {
    CHECK(irc_name_eq("#chan", "#CHAN"));
    CHECK(irc_name_eq("AzzuRRa", "azzurra"));
    CHECK(!irc_name_eq("#chan", "#chan2"));
    /* CASEMAPPING=ascii: the bracket characters are ordinary, and two
     * nicks that differ in them are two people (#525). */
    CHECK(!irc_name_eq("foo[1]", "foo{1}"));
    /* Non-ASCII is left alone — the ircd keeps those apart. */
    CHECK(!irc_name_eq("#caf\xc3\x89", "#caf\xc3\xa9"));
}

TEST(a_channel_opened_twice_in_two_spellings_is_one_window) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#Sniffo", false);
    add_window_ex(app, "azzurra", "#sniffo", false);
    add_window_ex(app, "AzzuRRa", "#SNIFFO", false);
    CHECK_LONG(app->window_count, 1);
    /* The FIRST spelling is what stays on screen: a window does not
     * rename itself under the user because a later message shouted. */
    CHECK_STR(app->windows[0].channel, "#Sniffo");
    free_app(app);
}

TEST(a_query_answered_in_another_case_reuses_its_window) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "Alice", false);
    add_window_ex(app, "azzurra", "alice", false);
    CHECK_LONG(app->window_count, 1);
    free_app(app);
}

TEST(a_row_files_under_its_windows_canonical_key) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#Sniffo", true);

    /* A row whose prefix shouts, and a window whose name does not. */
    log_line(app, "[AzzuRRa/#SNIFFO] 10:00 <alice> ciao");
    char want[MAX_SLUG + MAX_CHANNEL + 8];
    window_scope_key(app->windows[0].network, app->windows[0].channel, want, sizeof(want));
    CHECK_STR(want, "[azzurra/#sniffo]");
    CHECK(log_row_in_scope(app, app->log_count - 1, want));

    /* A different channel still does not leak in. */
    log_line(app, "[azzurra/#other] 10:01 <bob> altrove");
    CHECK(!log_row_in_scope(app, app->log_count - 1, want));
    free_app(app);
}

TEST(the_server_window_is_a_name_not_a_spelling) {
    CHECK(is_server_window("$server"));
    CHECK(is_server_window("$SERVER"));
    CHECK(!is_server_window("#server"));
}

TEST(traffic_named_after_the_network_is_the_server_talking) {
    CHECK_STR(route_target("azzurra", "AzzuRRa"), "$server");
    CHECK_STR(route_target("azzurra", "azzurra"), "$server");
    /* A person, a channel and the server window itself are left alone. */
    CHECK_STR(route_target("azzurra", "alice"), "alice");
    CHECK_STR(route_target("azzurra", "#azzurra"), "#azzurra");
    CHECK_STR(route_target("azzurra", "$server"), "$server");
}

TEST(the_server_talking_opens_no_window_of_its_own) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "$server", false);
    /* Both spellings the ircd has used, and the query window grappa
     * minted for them. None of it is a new tab. */
    add_window_ex(app, "azzurra", "AzzuRRa", false);
    add_window_ex(app, "azzurra", "azzurra", false);
    CHECK_LONG(app->window_count, 1);
    CHECK_STR(app->windows[0].channel, "$server");
    free_app(app);
}

TEST(a_reply_card_lands_in_the_window_that_asked) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "$server", false);
    add_window_ex(app, "azzurra", "#sniffo", true); /* what the user is reading */

    card(app, "azzurra", "--- WHOIS alice");
    char here[MAX_SLUG + MAX_CHANNEL + 8], server[MAX_SLUG + MAX_CHANNEL + 8];
    window_scope_key("azzurra", "#sniffo", here, sizeof(here));
    window_scope_key("azzurra", "$server", server, sizeof(server));
    CHECK(log_row_in_scope(app, app->log_count - 1, here));
    CHECK(!log_row_in_scope(app, app->log_count - 1, server));

    /* An answer from a network the reader is not in stays on that
     * network's server window rather than barging into the channel. */
    card(app, "other", "--- WHOIS bob");
    char elsewhere[MAX_SLUG + MAX_CHANNEL + 8];
    window_scope_key("other", "$server", elsewhere, sizeof(elsewhere));
    CHECK(log_row_in_scope(app, app->log_count - 1, elsewhere));
    CHECK(!log_row_in_scope(app, app->log_count - 1, here));
    free_app(app);
}

/* ── The block list ────────────────────────────────────────────────── */

TEST(a_block_matches_the_person_not_the_spelling) {
    struct app *app = window_app();
    CHECK(app != NULL);
    CHECK(block_add_locked(app, "SpamMer"));
    CHECK(is_blocked_locked(app, "spammer"));
    CHECK(is_blocked_locked(app, "SPAMMER"));
    CHECK(!is_blocked_locked(app, "spammer2"));
    /* Adding twice is not two entries, and says so by returning false. */
    CHECK(!block_add_locked(app, "spammer"));
    CHECK_LONG(app->block_count, 1);
    /* Removing takes any spelling too, and only the once. */
    CHECK(block_remove_locked(app, "SPAMMER"));
    CHECK(!block_remove_locked(app, "spammer"));
    CHECK_LONG(app->block_count, 0);
    free_app(app);
}

TEST(a_blocked_person_is_not_drawn_but_is_still_counted) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);
    block_add_locked(app, "spammer");

    struct wire_scrollback_message m = { 0 };
    m.id = 41;
    m.network = "azzurra";
    m.channel = "#sniffo";
    m.sender = "alice";
    m.body = "ciao";
    m.kind = MSG_PRIVMSG;
    render_message(app, &m, true);
    size_t after_alice = app->log_count;
    CHECK(after_alice > 0);

    m.id = 42;
    m.sender = "SpamMer"; /* the same person, shouting */
    m.body = "buy things";
    render_message(app, &m, true);
    /* Nothing drawn... */
    CHECK_LONG(app->log_count, after_alice);
    /* ...but the window still knows how far the conversation got, so
     * reconnecting does not re-deliver what was hidden. */
    CHECK_LONG(app->windows[0].last_id, 42);
    /* And the row that IS on screen keeps its own id: a hidden message
     * must not stamp its id onto somebody else's line, which is what
     * drags the unread divider onto the wrong row. */
    CHECK_LONG(app->log_ids[after_alice - 1], 41);
    free_app(app);
}

/* ── The right-click menu ──────────────────────────────────────────── */

static size_t menu_for(struct app *app, const char *nick, struct overlay_item *items, size_t max) {
    app->overlay.kind = OVERLAY_MENU;
    snprintf(app->overlay.nick, sizeof(app->overlay.nick), "%s", nick);
    snprintf(app->overlay.body, sizeof(app->overlay.body), "%s", "something they said");
    return overlay_items(app, items, max);
}

static bool menu_offers(struct overlay_item *items, size_t n, enum overlay_action action) {
    for (size_t i = 0; i < n; i++)
        if (items[i].action == action) return true;
    return false;
}

TEST(the_menu_offers_the_op_actions_only_to_an_op) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);
    struct window *w = &app->windows[0];
    snprintf(w->members[0].nick, sizeof(w->members[0].nick), "vjt");
    snprintf(w->members[0].modes, sizeof(w->members[0].modes), "+"); /* voiced, not op */
    snprintf(w->members[1].nick, sizeof(w->members[1].nick), "alice");
    w->member_count = 2;

    struct overlay_item items[64];
    size_t n = menu_for(app, "alice", items, 64);
    /* Everyone gets these. */
    CHECK(menu_offers(items, n, ACT_REPLY));
    CHECK(menu_offers(items, n, ACT_QUERY));
    CHECK(menu_offers(items, n, ACT_WHOIS));
    CHECK(menu_offers(items, n, ACT_PING));
    CHECK(menu_offers(items, n, ACT_BLOCK));
    /* A voiced user cannot kick, so the menu does not pretend. */
    CHECK(!menu_offers(items, n, ACT_KICK));
    CHECK(!menu_offers(items, n, ACT_BAN));
    CHECK(!menu_offers(items, n, ACT_KICKBAN));

    snprintf(w->members[0].modes, sizeof(w->members[0].modes), "@");
    n = menu_for(app, "alice", items, 64);
    CHECK(menu_offers(items, n, ACT_KICK));
    CHECK(menu_offers(items, n, ACT_BAN));
    CHECK(menu_offers(items, n, ACT_KICKBAN));
    free_app(app);
}

TEST(op_actions_stay_out_of_a_query_window) {
    struct app *app = window_app();
    CHECK(app != NULL);
    /* @ carried in a channel says nothing about a private conversation:
     * there is nobody to kick out of a query. */
    add_window_ex(app, "azzurra", "alice", true);
    struct window *w = &app->windows[0];
    snprintf(w->members[0].nick, sizeof(w->members[0].nick), "vjt");
    snprintf(w->members[0].modes, sizeof(w->members[0].modes), "@");
    w->member_count = 1;
    struct overlay_item items[64];
    size_t n = menu_for(app, "alice", items, 64);
    CHECK(!menu_offers(items, n, ACT_KICK));
    CHECK(menu_offers(items, n, ACT_PING));
    free_app(app);
}

TEST(the_block_entry_is_a_toggle) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);
    struct overlay_item items[64];
    size_t n = menu_for(app, "alice", items, 64);
    CHECK(menu_offers(items, n, ACT_BLOCK));
    CHECK(!menu_offers(items, n, ACT_UNBLOCK));

    block_add_locked(app, "ALICE");
    n = menu_for(app, "alice", items, 64);
    CHECK(menu_offers(items, n, ACT_UNBLOCK));
    CHECK(!menu_offers(items, n, ACT_BLOCK));
    free_app(app);
}

/* ── CTCP replies ──────────────────────────────────────────────────── */

TEST(a_ctcp_reply_is_an_answer_not_a_message) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "$server", false);
    add_window_ex(app, "azzurra", "#sniffo", true);

    struct wire_scrollback_message m = { 0 };
    m.id = 7;
    m.network = "azzurra";
    m.channel = "vjt";
    m.sender = "alice";
    m.kind = MSG_NOTICE;
    char body[64];
    snprintf(body, sizeof(body), "\001PING %ld\001", monotonic_ms() - 420);
    m.body = body;
    render_message(app, &m, true);

    /* Drawn as a card, in the window the user is reading — not as a raw
     * control-character line, and not in a query window of its own. */
    CHECK_LONG(app->window_count, 2);
    const char *row = app->log[app->log_count - 1];
    CHECK(strstr(row, "PING reply from alice") != NULL);
    CHECK(strstr(row, "\001") == NULL);
    char here[MAX_SLUG + MAX_CHANNEL + 8];
    window_scope_key("azzurra", "#sniffo", here, sizeof(here));
    CHECK(log_row_in_scope(app, app->log_count - 1, here));

    /* A CTCP we did not stamp is shown for what it is rather than turned
     * into a nonsense duration. */
    m.id = 8;
    m.body = "\001VERSION irssi 1.4.5\001";
    render_message(app, &m, true);
    CHECK(strstr(app->log[app->log_count - 1], "CTCP VERSION reply from alice: irssi 1.4.5") != NULL);
    free_app(app);
}

/* ── Operator verbs ───────────────────────────────────────────────────
 *
 * These go out as raw lines, so the only thing that can be wrong is the
 * line — a missing colon turns a reason into a truncated first word, and
 * a colon where the ircd wanted a parameter turns a K:line duration into
 * text. That is what is asserted here. */

static const struct oper_verb *oper_verb_named(const char *verb) {
    for (size_t i = 0; i < sizeof(oper_verbs) / sizeof(oper_verbs[0]); i++)
        if (strcmp(oper_verbs[i].verb, verb) == 0) return &oper_verbs[i];
    return NULL;
}

static const char *oper_line(const char *verb, const char *args) {
    static char out[MAX_LINE];
    const struct oper_verb *v = oper_verb_named(verb);
    if (!v) return "(no such verb)";
    if (!oper_verb_line(v, args, out, sizeof(out))) return "(refused)";
    return out;
}

TEST(oper_verbs_put_their_arguments_where_the_ircd_wants_them) {
    /* A reason is a trailing parameter: everything after the nick, in
     * one piece, spaces and all. */
    CHECK_STR(oper_line("/kill", "alice being rude on #chan"),
              "KILL alice :being rude on #chan");
    CHECK_STR(oper_line("/squit", "hub.azzurra.org rerouting"),
              "SQUIT hub.azzurra.org :rerouting");
    /* The broadcasts are all trailing parameter. */
    CHECK_STR(oper_line("/wallops", "netsplit incoming"), "WALLOPS :netsplit incoming");
    CHECK_STR(oper_line("/globops", "who is on duty?"), "GLOBOPS :who is on duty?");
    CHECK_STR(oper_line("/locops", "local only"), "LOCOPS :local only");
    /* bahamut's K:line takes an optional leading duration, which must
     * NOT be read as the mask. */
    CHECK_STR(oper_line("/kline", "*@spam.example flooding"),
              "KLINE *@spam.example :flooding");
    CHECK_STR(oper_line("/kline", "3600 *@spam.example flooding"),
              "KLINE 3600 *@spam.example :flooding");
    /* Server-specific grammar goes through untouched — a colon we
     * invented would corrupt it. */
    CHECK_STR(oper_line("/sconnect", "leaf.azzurra.org 6667"), "CONNECT leaf.azzurra.org 6667");
    CHECK_STR(oper_line("/trace", ""), "TRACE");
    CHECK_STR(oper_line("/trace", "alice"), "TRACE alice");
    CHECK_STR(oper_line("/die", ""), "DIE");
}

TEST(an_oper_verb_missing_its_arguments_is_refused_not_sent) {
    /* Half a KILL is not a KILL: the server would reject it, and the
     * user would read the rejection as the client having sent nothing. */
    CHECK_STR(oper_line("/kill", "alice"), "(refused)");
    CHECK_STR(oper_line("/kill", ""), "(refused)");
    CHECK_STR(oper_line("/wallops", ""), "(refused)");
    CHECK_STR(oper_line("/kline", "3600"), "(refused)");
    CHECK_STR(oper_line("/kline", "*@host"), "(refused)");
    /* The ones whose arguments are genuinely optional still go. */
    CHECK_STR(oper_line("/restart", ""), "RESTART");
}

TEST(an_oper_verb_is_matched_as_a_whole_word) {
    /* /kill must not be answered by /kickban, and a verb must not
     * swallow a longer word that starts the same way. */
    CHECK(oper_verb_args("/kill alice", "/kill") != NULL);
    CHECK(oper_verb_args("/kill", "/kill") != NULL);
    CHECK(oper_verb_args("/killer alice", "/kill") == NULL);
    CHECK(oper_verb_args("/kickban alice", "/kill") == NULL);
}

TEST(every_oper_verb_explains_itself) {
    for (size_t i = 0; i < sizeof(oper_verbs) / sizeof(oper_verbs[0]); i++) {
        const struct oper_verb *v = &oper_verbs[i];
        /* The table IS the help: a topic that does not start with the
         * verb is a topic about something else. */
        CHECK(v->usage != NULL);
        CHECK(strncmp(v->usage, v->verb, strlen(v->verb)) == 0);
        /* And the wire verb is the ircd's, in the ircd's case. */
        for (const char *c = v->wire; *c; c++) CHECK(*c >= 'A' && *c <= 'Z');
    }
}

TEST(kill_is_offered_only_to_an_oper) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);
    struct overlay_item items[64];

    size_t n = menu_for(app, "alice", items, 64);
    CHECK(!menu_offers(items, n, ACT_KILL));

    /* +o arrives from the server, not from having typed /oper. */
    snprintf(app->networks[0].umodes, sizeof(app->networks[0].umodes), "iwS");
    n = menu_for(app, "alice", items, 64);
    CHECK(!menu_offers(items, n, ACT_KILL));

    snprintf(app->networks[0].umodes, sizeof(app->networks[0].umodes), "iwo");
    n = menu_for(app, "alice", items, 64);
    CHECK(menu_offers(items, n, ACT_KILL));

    /* Network-wide, so it is offered in a query window too — unlike the
     * channel-op actions. */
    add_window_ex(app, "azzurra", "bob", true);
    n = menu_for(app, "bob", items, 64);
    CHECK(menu_offers(items, n, ACT_KILL));
    CHECK(!menu_offers(items, n, ACT_KICK));
    free_app(app);
}

/* ── /wire ─────────────────────────────────────────────────────────── */

TEST(the_wire_echo_never_prints_a_payload) {
    char out[MAX_LINE];
    /* The verb and the network it names — that is the diagnostic. */
    wire_push_summary("whois", "{\"network_id\":7,\"nick\":\"alice\"}", out, sizeof(out));
    CHECK_STR(out, "wire -> whois (network_id=7)");
    CHECK(strstr(out, "alice") == NULL);

    /* And NOT the payload, which is where the passwords are: /oper
     * carries one directly, and a raw line carries whatever was typed —
     * including the IDENTIFY every network's services want. A debug
     * switch that leaks a credential is worse than the bug it was turned
     * on to find. */
    wire_push_summary("oper", "{\"network_id\":7,\"name\":\"vjt\",\"password\":\"hunter2\"}", out,
                      sizeof(out));
    CHECK(strstr(out, "hunter2") == NULL);
    CHECK(strstr(out, "vjt") == NULL);
    wire_push_summary("raw", "{\"network_id\":7,\"line\":\"PRIVMSG NickServ :IDENTIFY hunter2\"}",
                      out, sizeof(out));
    CHECK(strstr(out, "hunter2") == NULL);
    CHECK(strstr(out, "IDENTIFY") == NULL);

    /* A payload without a network still names its verb. */
    wire_push_summary("read_cursor", "{\"channel\":\"#c\"}", out, sizeof(out));
    CHECK_STR(out, "wire -> read_cursor");
}

/* ── Phoenix v2 framing ────────────────────────────────────────────── */

TEST(a_push_carries_the_joins_ref_not_its_own) {
    /* [join_ref, ref, topic, event, payload]. On a client push the FIRST
     * slot must be the ref of the phx_join that opened the channel:
     * Phoenix matches it against the channel's own join_ref and discards
     * anything else with no reply and no error. Sending a fresh ref in
     * both slots — which this client did — meant every verb it asked
     * (whois, lusers, motd, away, quote, read cursors) was thrown away
     * in silence, while REST verbs and server→client pushes kept
     * working. That is the bug this test exists for. */
    char *join = ws_v2_frame(3, 3, "grappa:user:vjt", "phx_join", "{}");
    CHECK_STR(join, "[\"3\",\"3\",\"grappa:user:vjt\",\"phx_join\",{}]");
    free(join);

    char *push = ws_v2_frame(3, 7, "grappa:user:vjt", "whois", "{\"nick\":\"alice\"}");
    CHECK_STR(push, "[\"3\",\"7\",\"grappa:user:vjt\",\"whois\",{\"nick\":\"alice\"}]");
    free(push);

    /* The heartbeat rides a topic nobody joins, so its join_ref is null
     * rather than a number that matches no channel. */
    char *hb = ws_v2_frame(0, 9, "phoenix", "heartbeat", "{}");
    CHECK_STR(hb, "[null,\"9\",\"phoenix\",\"heartbeat\",{}]");
    free(hb);
}

int main(void) {
    RUN(names_are_compared_under_the_ircds_casemapping);
    RUN(a_channel_opened_twice_in_two_spellings_is_one_window);
    RUN(a_query_answered_in_another_case_reuses_its_window);
    RUN(a_row_files_under_its_windows_canonical_key);
    RUN(the_server_window_is_a_name_not_a_spelling);
    RUN(traffic_named_after_the_network_is_the_server_talking);
    RUN(the_server_talking_opens_no_window_of_its_own);
    RUN(a_reply_card_lands_in_the_window_that_asked);
    RUN(a_block_matches_the_person_not_the_spelling);
    RUN(a_blocked_person_is_not_drawn_but_is_still_counted);
    RUN(the_menu_offers_the_op_actions_only_to_an_op);
    RUN(op_actions_stay_out_of_a_query_window);
    RUN(the_block_entry_is_a_toggle);
    RUN(a_ctcp_reply_is_an_answer_not_a_message);
    RUN(oper_verbs_put_their_arguments_where_the_ircd_wants_them);
    RUN(an_oper_verb_missing_its_arguments_is_refused_not_sent);
    RUN(an_oper_verb_is_matched_as_a_whole_word);
    RUN(every_oper_verb_explains_itself);
    RUN(kill_is_offered_only_to_an_oper);
    RUN(the_wire_echo_never_prints_a_payload);
    RUN(a_push_carries_the_joins_ref_not_its_own);
    return test_report();
}
