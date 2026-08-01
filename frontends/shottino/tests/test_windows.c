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
    /* 1, matching the live capture the admin tests replay — azzurra is
     * network 1 on a fresh instance, and the sessions tab resolves
     * `network_id` back to a slug through this table. */
    n->id = 1;
    return app;
}

static void free_app(struct app *app) {
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    /* Panel rows are heap-allocated too — the app owns them via
     * clear_panel_lines_locked in production. */
    for (size_t i = 0; i < app->panel_line_count; i++) free(app->panel_lines[i]);
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

/* Does any row in the buffer say this? Used where a row is not
 * necessarily the LAST one — answering a CTCP query writes a line of
 * its own after the card. */
static bool log_has(struct app *app, const char *needle) {
    for (size_t i = 0; i < app->log_count; i++)
        if (strstr(app->log[i], needle)) return true;
    return false;
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
    /* Registered first: a PING reply is only OURS if we are waiting on
     * that exact stamp. This test used to send an unregistered one and
     * expect it reported, which is the behaviour that announced a round
     * trip for somebody else's ping crossing our scrollback. */
    long stamp = monotonic_ms() - 420;
    ping_remember(app, "azzurra", "alice", stamp);
    char body[64];
    snprintf(body, sizeof(body), "\001PING %ld\001", stamp);
    m.body = body;
    render_message(app, &m, true);
    CHECK(app->log_count > 0);

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
    CHECK(verb_args("/kill alice", "/kill") != NULL);
    CHECK(verb_args("/kill", "/kill") != NULL);
    CHECK(verb_args("/killer alice", "/kill") == NULL);
    CHECK(verb_args("/kickban alice", "/kill") == NULL);
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

/* ── CTCP ping lifecycle ───────────────────────────────────────────── */

TEST(a_ping_reply_is_matched_against_the_pings_we_are_waiting_on) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "$server", false);
    add_window_ex(app, "azzurra", "#sniffo", true);

    long stamp = monotonic_ms() - 420;
    ping_remember(app, "azzurra", "Alice", stamp);
    CHECK_LONG(app->ping_count, 1);

    /* The reply comes back from the same person in whatever case the
     * ircd spells them, and claims the entry exactly once. */
    CHECK(ping_claim(app, "azzurra", "alice", stamp));
    CHECK_LONG(app->ping_count, 0);
    CHECK(!ping_claim(app, "azzurra", "alice", stamp));

    /* Somebody else's ping, and our own stamp from another network, are
     * not ours to report. */
    ping_remember(app, "azzurra", "alice", stamp);
    CHECK(!ping_claim(app, "azzurra", "bob", stamp));
    CHECK(!ping_claim(app, "other", "alice", stamp));
    CHECK(!ping_claim(app, "azzurra", "alice", stamp + 1));
    CHECK_LONG(app->ping_count, 1);
    free_app(app);
}

TEST(a_backfilled_ping_reply_still_reports_its_round_trip) {
    /* The reply to a ping that opened no query window arrives ONLY in
     * that window's backfill — not live. Reporting live-only (which the
     * first version did) meant /ping answered nothing at all for anyone
     * you were not already talking to. */
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "$server", false);
    add_window_ex(app, "azzurra", "#sniffo", true);

    long stamp = monotonic_ms() - 250;
    ping_remember(app, "azzurra", "alice", stamp);

    char body[64];
    snprintf(body, sizeof(body), "\001PING %ld\001", stamp);
    struct wire_scrollback_message m = { 0 };
    m.id = 5;
    m.network = "azzurra";
    m.channel = "vjt";
    m.sender = "alice";
    m.kind = MSG_NOTICE;
    m.body = body;
    render_message(app, &m, false); /* NOT live: this is the backfill */

    const char *row = app->log[app->log_count - 1];
    CHECK(strstr(row, "PING reply from alice") != NULL);
    CHECK_LONG(app->ping_count, 0);
    free_app(app);
}

TEST(an_unsolicited_ping_reply_is_never_reported_as_our_round_trip) {
    /* A reply we never asked for must not be announced as a round trip
     * that never happened — no "PING reply from X: N.NNs" line, because
     * the stamp is not ours to subtract from. Live, it IS shown for what
     * it is (see a_ping_reply_we_did_not_time_is_still_shown_when_live);
     * out of a backfill it stays silent entirely. */
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);

    struct wire_scrollback_message m = { 0 };
    m.id = 6;
    m.network = "azzurra";
    m.channel = "vjt";
    m.sender = "mallory";
    m.kind = MSG_NOTICE;
    m.body = "\001PING 12345\001";
    render_message(app, &m, true);
    /* The TIMED form is "--- PING reply from X: N.NNs"; the untimed one
     * is "--- CTCP PING reply from X: <token>". Distinguished by the
     * prefix, so this asserts the absence of the former rather than
     * matching a substring both share. */
    CHECK(!log_has(app, "--- PING reply from mallory"));
    CHECK(log_has(app, "--- CTCP PING reply from mallory: 12345"));

    /* Backfilled: nothing at all. */
    size_t before = app->log_count;
    m.id = 7;
    render_message(app, &m, false);
    CHECK_LONG(app->log_count, before);
    free_app(app);
}

TEST(an_inbound_ctcp_query_is_named_not_dumped) {
    /* What a self-ping used to look like: `^APING 1234^A` drawn as a
     * chat line in a query window with yourself. It is a question asked
     * of this session, so it reads as one — and it opens no window. */
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "$server", false);
    add_window_ex(app, "azzurra", "#sniffo", true);
    size_t windows_before = app->window_count;

    struct wire_scrollback_message m = { 0 };
    m.id = 7;
    m.network = "azzurra";
    m.channel = "vjt";
    m.sender = "vjt";
    m.kind = MSG_PRIVMSG;
    m.body = "\001PING 1753776000123\001";
    render_message(app, &m, true);

    CHECK(log_has(app, "CTCP PING from vjt"));
    CHECK(!log_has(app, "\001"));
    CHECK_LONG(app->window_count, windows_before);
    free_app(app);
}

TEST(a_ctcp_query_is_answered_only_where_it_is_ours_to_answer) {
    char verb[32], payload[MAX_LINE];

    /* The split the responder and the renderer share. */
    ctcp_split("\001PING 1753776000123\001", verb, sizeof(verb), payload, sizeof(payload));
    CHECK_STR(verb, "PING");
    CHECK_STR(payload, "1753776000123");

    /* Lowercase verbs are the same verb; a token-less query has no
     * token rather than a made-up one. */
    ctcp_split("\001ping\001", verb, sizeof(verb), payload, sizeof(payload));
    CHECK_STR(verb, "PING");
    CHECK_STR(payload, "");

    /* The payload is copied verbatim — spaces and all — because for
     * PING it is the asker's token and must return unchanged. */
    ctcp_split("\001PING a b c\001", verb, sizeof(verb), payload, sizeof(payload));
    CHECK_STR(payload, "a b c");

    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);

    /* VERSION is grappa's to answer — it is awake when this client is
     * not, and two answers to one query is worse than none. Asking the
     * responder to handle it must do nothing at all. */
    app->ctcp_last_reply_ms = 0;
    ctcp_respond(app, "azzurra", "alice", "VERSION", "");
    CHECK_LONG(app->ctcp_last_reply_ms, 0);

    /* A nameless sender is nobody to answer. */
    ctcp_respond(app, "azzurra", "", "PING", "1");
    CHECK_LONG(app->ctcp_last_reply_ms, 0);

    /* A PING is answered — the throttle stamp is the observable part
     * here; the socket is not connected in a test, so the push itself
     * is a no-op. */
    ctcp_respond(app, "azzurra", "alice", "PING", "1");
    CHECK(app->ctcp_last_reply_ms != 0);

    /* And the next one, immediately after, is throttled: a client that
     * answers every query in a flood is a client that can be pointed at
     * the server. */
    long first = app->ctcp_last_reply_ms;
    ctcp_respond(app, "azzurra", "bob", "PING", "2");
    CHECK_LONG(app->ctcp_last_reply_ms, first);

    /* A token too long to fit an IRC line is NOT echoed: the asker would
     * receive a truncated one back and rightly ignore it, and answering
     * with a corrupted echo is a lie about what they sent. */
    static char huge[CTCP_REPLY_MAX_TOKEN + 64];
    memset(huge, 'x', sizeof(huge) - 1);
    huge[sizeof(huge) - 1] = 0;
    app->ctcp_last_reply_ms = 0;
    ctcp_respond(app, "azzurra", "alice", "PING", huge);
    CHECK_LONG(app->ctcp_last_reply_ms, 0);
    free_app(app);
}

TEST(a_ping_reply_routed_to_server_still_lands_in_the_active_window) {
    /* grappa carves a CTCP-framed NOTICE out of the peer-DM route and
     * persists it on $server, so it mints no query window. The reply then
     * arrives with channel = "$server" rather than the peer's name — and
     * it must STILL be reported where the question was asked, exactly
     * like /whois. The client keys on the FRAMING and the outstanding
     * ping, never on which window the row was filed under, which is what
     * makes it survive that routing change. */
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "$server", false);
    add_window_ex(app, "azzurra", "#sniffo", true);

    long stamp = monotonic_ms() - 310;
    ping_remember(app, "azzurra", "alice", stamp);

    char body[64];
    snprintf(body, sizeof(body), "\001PING %ld\001", stamp);
    struct wire_scrollback_message m = { 0 };
    m.id = 9;
    m.network = "azzurra";
    m.channel = "$server"; /* where grappa now files it */
    m.sender = "alice";
    m.kind = MSG_NOTICE;
    m.body = body;
    render_message(app, &m, true);

    CHECK(log_has(app, "PING reply from alice"));
    /* In the window being READ, not in $server. */
    char here[MAX_SLUG + MAX_CHANNEL + 8], server[MAX_SLUG + MAX_CHANNEL + 8];
    window_scope_key("azzurra", "#sniffo", here, sizeof(here));
    window_scope_key("azzurra", "$server", server, sizeof(server));
    CHECK(log_row_in_scope(app, app->log_count - 1, here));
    CHECK(!log_row_in_scope(app, app->log_count - 1, server));
    /* And no tab for the person we pinged. */
    CHECK_LONG(app->window_count, 2);
    free_app(app);
}

TEST(a_ctcp_query_is_framed_the_way_the_protocol_expects) {
    char out[MAX_LINE];

    /* `<target> <VERB> [args]` → `PRIVMSG target :\001VERB args\001`.
     * The verb upcases (protocol convention, and services match on it);
     * the arguments go through VERBATIM, because for PING they are a
     * token that has to round-trip. */
    CHECK(ctcp_request_line("alice VERSION", out, sizeof(out)));
    CHECK_STR(out, "PRIVMSG alice :\001VERSION\001");

    CHECK(ctcp_request_line("alice version", out, sizeof(out)));
    CHECK_STR(out, "PRIVMSG alice :\001VERSION\001");

    CHECK(ctcp_request_line("alice PING 1753776000123", out, sizeof(out)));
    CHECK_STR(out, "PRIVMSG alice :\001PING 1753776000123\001");

    /* A channel is a legal CTCP target. */
    CHECK(ctcp_request_line("#sniffo TIME", out, sizeof(out)));
    CHECK_STR(out, "PRIVMSG #sniffo :\001TIME\001");

    /* Multi-word arguments stay whole. */
    CHECK(ctcp_request_line("alice ACTION waves at you", out, sizeof(out)));
    CHECK_STR(out, "PRIVMSG alice :\001ACTION waves at you\001");

    /* Missing verb or target is usage, not `PRIVMSG  :\001\001`. */
    CHECK(!ctcp_request_line("alice", out, sizeof(out)));
    CHECK(!ctcp_request_line("", out, sizeof(out)));
    CHECK(!ctcp_request_line("   ", out, sizeof(out)));
}

TEST(a_ping_reply_we_did_not_time_is_still_shown_when_live) {
    /* `/ctcp nick PING <own-token>` gets an answer this client never
     * registered. Silently dropping it — which the matched-only rule did
     * — makes /ctcp PING look broken. Live, it is reported for what it
     * is; out of a backfill it stays quiet, because timing it against a
     * stamp from a previous run would be a lie. */
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);

    struct wire_scrollback_message m = { 0 };
    m.id = 11;
    m.network = "azzurra";
    m.channel = "$server";
    m.sender = "alice";
    m.kind = MSG_NOTICE;
    m.body = "\001PING deadbeef\001";
    render_message(app, &m, true);
    CHECK(log_has(app, "CTCP PING reply from alice: deadbeef"));

    size_t before = app->log_count;
    m.id = 12;
    render_message(app, &m, false); /* backfilled: stays quiet */
    CHECK_LONG(app->log_count, before);
    free_app(app);
}

/* ── Audio ─────────────────────────────────────────────────────────── */

TEST(audio_is_classified_before_the_uploads_heuristic) {
    /* The trap this test exists for: `/uploads/` marks anything this
     * deployment hosts as a picture, so an uploaded .mp3 would be handed
     * to the image decoder and look broken rather than unsupported.
     * Audio has to win first. */
    CHECK_LONG(media_kind_of("https://irc.example/uploads/abc123.mp3"), MEDIA_AUDIO);
    CHECK_LONG(media_kind_of("https://irc.example/uploads/abc123.png"), MEDIA_IMAGE);
    /* A bare /uploads/ URL with no extension stays a picture — that is
     * the pre-existing heuristic, deliberately untouched. */
    CHECK_LONG(media_kind_of("https://irc.example/uploads/abc123"), MEDIA_IMAGE);

    /* Every extension /upload can send, plus the ones it cannot: the
     * server refuses ogg/opus UPLOADS, but a link to somebody else's is
     * still audio and still playable. */
    const char *audio[] = {"http://h/a.mp3",  "http://h/a.m4a", "http://h/a.m4r",
                           "http://h/a.aac",  "http://h/a.wav", "http://h/a.flac",
                           "http://h/a.ogg",  "http://h/a.oga", "http://h/a.opus", NULL};
    for (size_t i = 0; audio[i]; i++) CHECK_LONG(media_kind_of(audio[i]), MEDIA_AUDIO);

    /* .ogv is VIDEO and must not be swallowed by the .ogg rule. */
    CHECK_LONG(media_kind_of("http://h/clip.ogv"), MEDIA_VIDEO);
    CHECK_LONG(media_kind_of("http://h/clip.mp4"), MEDIA_VIDEO);

    /* Case and a query string do not change the answer (same token
     * lowering every other kind goes through). */
    CHECK_LONG(media_kind_of("http://h/Song.MP3?sig=abc"), MEDIA_AUDIO);

    /* Not audio. */
    CHECK_LONG(media_kind_of("http://h/page.html"), MEDIA_NONE);

    /* Recording pre-existing behaviour rather than asserting what the
     * name promises: `token_has_suffix` is a strstr, so ANY extension
     * appearing anywhere in the token matches — `notes.mp3.txt` reads as
     * audio, exactly as `shot.png.txt` already reads as an image. Adding
     * a kind is not the change that should quietly tighten that for
     * every other kind too; noted, not fixed here. */
    CHECK_LONG(media_kind_of("http://h/notes.mp3.txt"), MEDIA_AUDIO);
    CHECK_LONG(media_kind_of("http://h/shot.png.txt"), MEDIA_IMAGE);
}

/* ── Admin panel wire shapes ───────────────────────────────────────────
 *
 * These renderers read the ADMIN API's JSON directly, and nothing linked
 * them to it: three of them had drifted to keys the server has never
 * sent, so the panel rendered "?" columns, a 0 B total and a visitor
 * count with no rows under it — all of it silent, because a missing JSON
 * key is indistinguishable from an empty one at the read site.
 *
 * The payloads below are VERBATIM captures from a live grappa
 * (0.8.0) — an invented fixture would only re-encode the same wrong
 * assumption the renderers made. */

static const char *const ADMIN_SESSIONS_JSON =
    "{\"sessions\":[{\"subject_kind\":\"user\",\"network_id\":1,"
    "\"subject_label\":\"nextime\","
    "\"subject_id\":\"df744b5e-ff5a-4d01-bf6f-fffb049e7f9e\","
    "\"last_seen_at\":\"2026-08-01T07:19:31.959297Z\","
    "\"live_state\":{\"alive\":true,\"peer_address\":\"15.161.158.234\","
    "\"peer_port\":6697,\"introspection_degraded\":[],"
    "\"joined_channels\":[\"#grappa\",\"#sniffo\",\"#vua\"],"
    "\"mailbox_len\":0,\"memory_bytes\":264648,\"peer_name\":null,"
    "\"pid_inspect\":\"#PID<0.893.0>\"}}]}";

static const char *const ADMIN_UPLOADS_JSON =
    "{\"live_bytes_sum\":0,\"global_cap_bytes\":10737418240,"
    "\"uploads\":[{\"id\":\"u1\",\"slug\":\"abc\",\"mime\":\"image/png\","
    "\"bytes\":2048,\"original_filename\":\"a.png\",\"subject_kind\":\"user\","
    "\"subject_id\":\"u\",\"expires_at\":null,\"deleted_at\":null,"
    "\"inserted_at\":\"2026-08-01T01:00:00Z\"}]}";

static const char *const ADMIN_VISITORS_JSON =
    "{\"visitors\":[{\"id\":\"v-123456789\",\"expires_at\":null,"
    "\"identified\":true,\"ip\":\"10.0.0.1\","
    "\"inserted_at\":\"2026-08-01T01:00:00Z\","
    "\"networks\":[{\"network_slug\":\"azzurra\",\"network_id\":1,"
    "\"nick\":\"guest42\",\"connection_state\":\"connected\","
    "\"live_state\":{\"alive\":true}}]}]}";

static void render_json(struct app *app, const char *json,
                        void (*render)(struct app *, const json_value *)) {
    json_doc *doc = json_parse(json, strlen(json), NULL, 0);
    CHECK(doc != NULL);
    if (!doc) return;
    render(app, json_root(doc));
    json_free(doc);
}

static bool panel_has(struct app *app, const char *needle) {
    for (size_t i = 0; i < app->panel_line_count; i++)
        if (strstr(app->panel_lines[i], needle)) return true;
    return false;
}

TEST(the_admin_sessions_tab_reads_the_shape_the_server_sends) {
    struct app *app = window_app();
    CHECK(app != NULL);
    render_json(app, ADMIN_SESSIONS_JSON, render_admin_sessions);

    /* network_id 1 resolves to the slug the client already knows. */
    CHECK(panel_has(app, "azzurra"));
    CHECK(panel_has(app, "user:nextime"));
    CHECK(panel_has(app, "alive"));
    /* joined_channels has three entries. */
    CHECK(panel_has(app, "3"));
    /* The old reader's tell was a row of literal question marks — one
     * per key it asked for and did not get. */
    CHECK(!panel_has(app, "?"));
    free_app(app);
}

TEST(the_admin_uploads_tab_totals_the_bytes_field) {
    struct app *app = window_app();
    CHECK(app != NULL);
    render_json(app, ADMIN_UPLOADS_JSON, render_admin_uploads);
    /* 2048 bytes — not the 0 B a `byte_size` reader reported. */
    CHECK(panel_has(app, "2.0 KB"));
    CHECK(!panel_has(app, "0 B total"));
    free_app(app);
}

TEST(the_admin_visitors_tab_renders_per_network_rows) {
    struct app *app = window_app();
    CHECK(app != NULL);
    render_json(app, ADMIN_VISITORS_JSON, render_admin_visitors);
    /* The row exists at all — the old top-level `nick` read made the
     * guard skip every visitor, so the count had nothing under it. */
    CHECK(panel_has(app, "v-123456789"));
    CHECK(panel_has(app, "identified"));
    /* The nick lives per-network, and so does its connection state. */
    CHECK(panel_has(app, "guest42"));
    CHECK(panel_has(app, "connected"));
    free_app(app);
}

TEST(a_setting_name_and_a_boolean_are_parsed_the_way_people_type_them) {
    bool v = false;
    /* Every spelling somebody reaches for, because "expected on or off"
     * after typing `yes` is a client arguing with its user. */
    const char *yes[] = { "on", "ON", "true", "1", "yes", "y", NULL };
    for (size_t i = 0; yes[i]; i++) {
        v = false;
        CHECK(setting_parse_bool(yes[i], &v));
        CHECK(v);
    }
    const char *no[] = { "off", "OFF", "false", "0", "no", "n", NULL };
    for (size_t i = 0; no[i]; i++) {
        v = true;
        CHECK(setting_parse_bool(no[i], &v));
        CHECK(!v);
    }
    /* Anything else is refused rather than guessed at. */
    CHECK(!setting_parse_bool("maybe", &v));
    CHECK(!setting_parse_bool("", &v));

    /* The registry is the answer to "what can I configure?" — a name
     * that dispatches must be findable, case-insensitively. */
    CHECK(setting_find("mouse") != NULL);
    CHECK(setting_find("LLM.Token") != NULL);
    CHECK(setting_find("nonesuch") == NULL);
}

TEST(the_settings_listing_never_prints_the_token) {
    struct app *app = window_app();
    CHECK(app != NULL);
    snprintf(app->llm.token, sizeof(app->llm.token), "sk-thisisasecret");
    snprintf(app->llm.model, sizeof(app->llm.model), "gpt-4o-mini");

    char out[256];
    setting_value(app, "llm.token", out, sizeof(out));
    CHECK_STR(out, "********");
    CHECK(strstr(out, "sk-") == NULL);

    /* Everything else reports itself normally — the masking is one
     * field's rule, not a blanket that hides the config. */
    setting_value(app, "llm.model", out, sizeof(out));
    CHECK_STR(out, "gpt-4o-mini");
    setting_value(app, "mouse", out, sizeof(out));
    CHECK(strcmp(out, "on") == 0 || strcmp(out, "off") == 0);
    free_app(app);
}

/* ── /bot: who may drive it ────────────────────────────────────────── */

TEST(a_nick_match_alone_is_never_the_owner) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);
    snprintf(app->bot_owner, sizeof(app->bot_owner), "nextime");

    /* Somebody using the owner's nick, with NOTHING known about their
     * services login. This is the whole attack: a nick is borrowed,
     * dropped and taken every day, and a bare match must not authorise
     * anything. Unverifiable means not the owner. */
    CHECK(!bot_sender_is_owner(app, "azzurra", "nextime"));

    /* A different nick is not the owner however authenticated it is. */
    whois_fact_record(app, "mallory", "mallory-account", true);
    CHECK(!bot_sender_is_owner(app, "azzurra", "mallory"));

    /* Verified by services → owner. */
    whois_fact_record(app, "nextime", "nextime-account", true);
    CHECK(bot_sender_is_owner(app, "azzurra", "nextime"));

    /* Known to services but NOT identified is still not the owner. */
    whois_fact_record(app, "nextime", "", false);
    CHECK(!bot_sender_is_owner(app, "azzurra", "nextime"));

    /* No owner configured: nobody on the network qualifies, ever. */
    app->bot_owner[0] = 0;
    whois_fact_record(app, "nextime", "nextime-account", true);
    CHECK(!bot_sender_is_owner(app, "azzurra", "nextime"));
    free_app(app);
}

TEST(a_grant_is_per_person_and_per_tool) {
    struct app *app = window_app();
    CHECK(app != NULL);
    bot_grant_add(app, "alice", "send_message");

    CHECK(bot_has_grant(app, "alice", "send_message"));
    /* Case-folded like every other nick compare. */
    CHECK(bot_has_grant(app, "ALICE", "send_message"));
    /* Approving her to SPEAK does not approve her to make the client
     * join channels — that is the point of granting per pair. */
    CHECK(!bot_has_grant(app, "alice", "join_channel"));
    /* And it does not approve anybody else for anything. */
    CHECK(!bot_has_grant(app, "bob", "send_message"));

    /* Adding twice does not double the row. */
    bot_grant_add(app, "alice", "send_message");
    CHECK_LONG(app->bot_grant_count, 1);
    free_app(app);
}

/* A memory's filename is BUILT from the title, never taken from it: the
 * model picks the words, and it must not be able to pick the path. */
TEST(a_memory_filename_is_built_not_taken) {
    char slug[128];

    CHECK(bot_memory_slug("Nextime prefers short answers", slug, sizeof(slug)));
    CHECK_STR(slug, "nextime-prefers-short-answers.md");

    /* Traversal is not rejected — it is UNREPRESENTABLE. Dots and
     * slashes are simply not in the alphabet the builder draws from. */
    CHECK(bot_memory_slug("../../.ssh/authorized_keys", slug, sizeof(slug)));
    CHECK(strstr(slug, "..") == NULL);
    CHECK(strchr(slug, '/') == NULL);
    CHECK_STR(slug, "ssh-authorized-keys.md");

    CHECK(bot_memory_slug("a\nb\tc", slug, sizeof(slug)));
    CHECK_STR(slug, "a-b-c.md");

    /* Nothing to build a name from is a refusal, not a file called
     * ".md" — an empty-named note nobody can list or forget. */
    CHECK(!bot_memory_slug("...", slug, sizeof(slug)));
    CHECK(!bot_memory_slug("", slug, sizeof(slug)));

    /* An over-long title truncates instead of overflowing, and stays a
     * .md file. */
    char loud[512];
    memset(loud, 'x', sizeof(loud) - 1);
    loud[sizeof(loud) - 1] = 0;
    char small[24];
    CHECK(bot_memory_slug(loud, small, sizeof(small)));
    CHECK(strlen(small) < sizeof(small));
    CHECK(strstr(small, ".md") != NULL);

    /* Listing skips the in-flight temp file: a concurrent writer's
     * half-written note must never be read as a memory. */
    CHECK(is_memory_file("note.md"));
    CHECK(!is_memory_file(".4242.tmp"));
    CHECK(!is_memory_file("notes.txt"));
    CHECK(!is_memory_file(".md"));
}

/* Several shottinos run side by side under one unix user. Two accounts
 * must not share one bot's memories. */
TEST(two_identities_get_two_bot_directories) {
    /* Heap, not stack: `struct app` carries the whole scrollback and is
     * far larger than a thread stack. */
    /* Plain calloc: bot_dir_path touches no lock and logs nothing, so
     * these carry no allocation to release. */
    struct app *a = calloc(1, sizeof(*a));
    struct app *b = calloc(1, sizeof(*b));
    char da[LLM_MAX_PATH], db[LLM_MAX_PATH];

    snprintf(a->url.base, sizeof(a->url.base), "https://grappa.example");
    snprintf(a->subject, sizeof(a->subject), "user:alice");
    snprintf(b->url.base, sizeof(b->url.base), "https://grappa.example");
    snprintf(b->subject, sizeof(b->subject), "user:bob");
    bot_dir_path(a, da, sizeof(da));
    bot_dir_path(b, db, sizeof(db));
    CHECK(strcmp(da, db) != 0);

    /* Same identity, second window: deliberately the SAME bot. */
    snprintf(b->subject, sizeof(b->subject), "user:alice");
    bot_dir_path(b, db, sizeof(db));
    CHECK_STR(db, da);

    /* Same account on a DIFFERENT bouncer is a different bot too. */
    snprintf(b->url.base, sizeof(b->url.base), "https://other.example");
    bot_dir_path(b, db, sizeof(db));
    CHECK(strcmp(db, da) != 0);

    /* An explicit bot.dir is honoured verbatim — sharing a brain across
     * sessions is allowed, as long as it is asked for. */
    snprintf(a->bot_dir, sizeof(a->bot_dir), "/tmp/shared-brain");
    bot_dir_path(a, da, sizeof(da));
    CHECK_STR(da, "/tmp/shared-brain");
    free(a);
    free(b);
}

/* "Approve always" that forgets at the next restart is not a grant, it
 * is a longer session. */
/* You must be able to type your own language.
 *
 * The input path took BYTES from getch() and filtered them with
 * isprint(), which in a UTF-8 locale is false for every byte >= 0x80, so
 * every accented character was dropped one byte at a time in silence:
 * `perché` went out as `perch`, on a client whose main network is
 * Italian. And Backspace deleted one BYTE, so erasing an accented
 * character left the lead byte of its sequence behind — an invalid
 * prefix that the next keystroke appended to. */
TEST(an_accented_character_survives_typing_and_one_backspace) {
    /* The locale the terminal actually runs in; without it wcrtomb
     * encodes to something that is not UTF-8 and the test would be
     * asserting the wrong thing. */
    CHECK(setlocale(LC_ALL, "C.UTF-8") != NULL || setlocale(LC_ALL, "en_US.UTF-8") != NULL);
    struct app *app = window_app();
    CHECK(app != NULL);

    const wchar_t word[] = L"perché";
    for (size_t i = 0; word[i]; i++) input_append_wide(app, word[i]);

    /* Six characters, seven bytes: é is two of them. The old path stored
     * five and dropped the rest. */
    CHECK(strcmp(app->input, "perch\xc3\xa9") == 0);
    CHECK_LONG(app->input_len, 7);

    /* One Backspace removes the whole character, not half of it. */
    input_backspace(app);
    CHECK(strcmp(app->input, "perch") == 0);
    CHECK_LONG(app->input_len, 5);

    /* And an ASCII one still removes exactly one byte. */
    input_backspace(app);
    CHECK(strcmp(app->input, "perc") == 0);

    /* A character that will not fit whole is refused whole: half a
     * sequence in the buffer is a line that cannot be sent. */
    app->input_len = sizeof(app->input) - 2;
    memset(app->input, 'x', app->input_len);
    app->input[app->input_len] = 0;
    input_append_wide(app, L'é');
    CHECK_LONG(app->input_len, sizeof(app->input) - 2);
    CHECK(app->input[app->input_len] == 0);

    free_app(app);
}

/* Three threads send on one websocket; a ref must belong to one of them.
 *
 * ws_ref was incremented from main, the job worker and the model thread
 * with nothing serialising them, so two frames could carry the SAME ref —
 * and Phoenix silently discards a push whose join_ref names no channel of
 * its own, which is the failure mode that hides. The socket itself is not
 * needed to test this: with ws_connected false nothing is written, and
 * what is under test is the number, not the write.
 *
 * Deterministic in the passing direction — with the lock the refs are
 * always distinct, so a slow box cannot make this red. Without it, this
 * much contention loses increments. */
#define REF_THREADS 4
#define REF_EACH 5000
static void *ref_grabber(void *arg) {
    struct app *app = arg;
    static _Thread_local unsigned long mine[REF_EACH];
    for (size_t i = 0; i < REF_EACH; i++) mine[i] = ws_join(app, "grappa:user:vjt");
    unsigned long *out = malloc(sizeof(mine));
    memcpy(out, mine, sizeof(mine));
    return out;
}

TEST(a_websocket_ref_is_never_handed_out_twice) {
    struct app *app = window_app();
    CHECK(app != NULL);
    pthread_mutex_init(&app->ws_lock, NULL);
    /* Not connected: ws_send_text_locked returns immediately and no
     * socket is touched, leaving the ref allocation as the whole test. */
    app->ws_connected = false;

    pthread_t t[REF_THREADS];
    for (size_t i = 0; i < REF_THREADS; i++)
        CHECK(pthread_create(&t[i], NULL, ref_grabber, app) == 0);

    /* Every ref ever handed out, marked in a bitmap: any repeat is a lost
     * increment, and the total must be exactly what was asked for. */
    static bool seen[REF_THREADS * REF_EACH + 2];
    size_t collected = 0, duplicates = 0, out_of_range = 0;
    for (size_t i = 0; i < REF_THREADS; i++) {
        unsigned long *refs = NULL;
        pthread_join(t[i], (void **)&refs);
        CHECK(refs != NULL);
        for (size_t k = 0; k < REF_EACH; k++) {
            collected++;
            if (refs[k] == 0 || refs[k] >= sizeof(seen) / sizeof(seen[0])) { out_of_range++; continue; }
            if (seen[refs[k]]) duplicates++;
            seen[refs[k]] = true;
        }
        free(refs);
    }
    CHECK_LONG(collected, REF_THREADS * REF_EACH);
    CHECK_LONG(duplicates, 0);
    CHECK_LONG(out_of_range, 0);
    CHECK_LONG(app->ws_ref, REF_THREADS * REF_EACH);

    pthread_mutex_destroy(&app->ws_lock);
    free_app(app);
}

/* Quitting has to be able to tell the model thread apart from a corpse.
 *
 * llm_stop was declared and read and assigned NOWHERE, so shutdown freed
 * every log line, destroyed app->lock and freed the app while that thread
 * was still parked on a condvar — and there was no way to ask whether it
 * had gone. An idle thread must notice the stop and SAY so, which is the
 * signal the shutdown path waits on before it frees anything. */
TEST(the_model_thread_announces_that_it_stopped) {
    struct app *app = window_app();
    CHECK(app != NULL);
    pthread_mutex_init(&app->llm_lock, NULL);
    pthread_cond_init(&app->llm_cond, NULL);

    pthread_t t;
    CHECK(pthread_create(&t, NULL, llm_main, app) == 0);

    /* Generous deadline: this asserts that the handshake HAPPENS, not how
     * quickly — a slow CI box must not turn into a red build. */
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += 5;
    pthread_mutex_lock(&app->llm_lock);
    app->llm_stop = true;
    pthread_cond_broadcast(&app->llm_cond);
    while (!app->llm_exited)
        if (pthread_cond_timedwait(&app->llm_cond, &app->llm_lock, &deadline) == ETIMEDOUT) break;
    bool exited = app->llm_exited;
    pthread_mutex_unlock(&app->llm_lock);

    CHECK(exited);
    pthread_join(t, NULL);
    pthread_cond_destroy(&app->llm_cond);
    pthread_mutex_destroy(&app->llm_lock);
    free_app(app);
}

/* Retiring a row must carry its whole row with it.
 *
 * Six arrays are parallel-indexed: the text, mention, pending-echo,
 * scrollback id, media slot, scope. clear_matching_pending_echo used to
 * memmove three of them by hand and leave the other three where they
 * were, so after every message you sent while its echo was on screen,
 * every row above it took on a NEIGHBOUR's id, image slot and window. The
 * ring's own comment says exactly two functions may know the full set;
 * this asserts that the retirement path is not a third. */
TEST(retiring_an_echo_moves_every_row_not_just_its_text) {
    struct app *app = window_app();
    CHECK(app != NULL);

    /* Three rows, each with metadata that names it, and the pending echo
     * FIRST so the two below it have to slide. */
    pthread_mutex_lock(&app->lock);
    log_push_locked(app, strdup("[azzurra/#sniffo] 10:00 <vjt> hello there"), false, true);
    log_push_locked(app, strdup("[azzurra/#sniffo] 10:01 <alice> second"), true, false);
    log_push_locked(app, strdup("[azzurra/#altro] 10:02 <bob> third"), false, false);
    app->log_ids[0] = 100; app->log_media[0] = 0;
    app->log_ids[1] = 101; app->log_media[1] = 1;
    app->log_ids[2] = 102; app->log_media[2] = 2;
    char scope1[MAX_SLUG + MAX_CHANNEL + 8], scope2[MAX_SLUG + MAX_CHANNEL + 8];
    snprintf(scope1, sizeof(scope1), "%s", app->log_scope[1]);
    snprintf(scope2, sizeof(scope2), "%s", app->log_scope[2]);
    pthread_mutex_unlock(&app->lock);
    CHECK_LONG(app->log_count, 3);

    clear_matching_pending_echo(app, "azzurra", "#sniffo", "hello there");
    CHECK_LONG(app->log_count, 2);

    /* Each surviving row still carries ITS id, ITS image and ITS window —
     * not the ones belonging to the row that used to sit below it. */
    CHECK(strstr(app->log[0], "second") != NULL);
    CHECK_LONG(app->log_ids[0], 101);
    CHECK_LONG(app->log_media[0], 1);
    CHECK(app->log_mentions[0]);
    CHECK(strcmp(app->log_scope[0], scope1) == 0);

    CHECK(strstr(app->log[1], "third") != NULL);
    CHECK_LONG(app->log_ids[1], 102);
    CHECK_LONG(app->log_media[1], 2);
    CHECK(!app->log_mentions[1]);
    CHECK(strcmp(app->log_scope[1], scope2) == 0);
    /* The two rows came from different channels, so a scope that did not
     * move would file one of them into the other's window. */
    CHECK(strcmp(scope1, scope2) != 0);

    free_app(app);
}

/* The bot's door, not its judgement.
 *
 * bot_consider spent its whole life inside the `default:` arm of
 * render_message's kind switch — the arm reached by exactly the kinds that
 * are NOT conversation — so its `conversational &&` guard was false every
 * time it ran and the bot never saw one message. Everything downstream (the
 * approval gate, the grants, the memories) was correct code behind a door
 * that never opened, which is why no test caught it: they all tested the
 * room and none tested the door.
 *
 * So this asserts reachability, at the only place it can be observed from
 * outside: a mention while /bot is on lands a turn on the llm queue. */
TEST(a_conversation_reaches_the_bot_and_a_join_does_not) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);
    app->bot_enabled = true;

    struct wire_scrollback_message m = { 0 };
    m.id = 1;
    m.network = "azzurra";
    m.channel = "#sniffo";
    m.sender = "alice";
    m.kind = MSG_PRIVMSG;
    m.body = "vjt: are you there?";   /* our own nick — a mention */
    render_message(app, &m, true);
    CHECK(app->llm_tail != app->llm_head);

    /* A PRESENCE row is not conversation and must NOT wake it: that is the
     * half of the guard the misplaced brace was accidentally enforcing,
     * and moving the call must not lose it. */
    size_t after_privmsg = app->llm_tail;
    m.id = 2;
    m.kind = MSG_JOIN;
    m.body = "";
    render_message(app, &m, true);
    CHECK_LONG(app->llm_tail, after_privmsg);

    /* Still ours only when we are addressed — an unrelated line in a
     * channel the bot is sitting in is not a question for it. */
    m.id = 3;
    m.kind = MSG_PRIVMSG;
    m.body = "alice is talking to bob about lunch";
    render_message(app, &m, true);
    CHECK_LONG(app->llm_tail, after_privmsg);

    free_app(app);
}

/* Every preference the panel shows must come back after a restart.
 *
 * Only the llm.* half had a writer: an STT endpoint, its token, the capture
 * devices and the three display toggles were set-and-lose, while the
 * settings panel presented both halves identically. */
TEST(a_preference_survives_a_restart) {
    char home[] = "/tmp/shottino-prefs-test-XXXXXX";
    CHECK(mkdtemp(home) != NULL);
    char *old_home = getenv("HOME");
    char *saved = old_home ? strdup(old_home) : NULL;
    setenv("HOME", home, 1);

    struct app *a = window_app();
    /* Through the same door /set uses, so the test cannot pass by
     * writing fields the real command would have parsed differently. */
    CHECK(setting_apply(a, setting_find("stt.url"), "https://whisper.example/v1"));
    CHECK(setting_apply(a, setting_find("stt.token"), "sk-not-a-real-key-8842"));
    CHECK(setting_apply(a, setting_find("voice.source"), "pulse:default"));
    CHECK(setting_apply(a, setting_find("media"), "all"));
    CHECK(setting_apply(a, setting_find("animate"), "off"));
    prefs_save(a);

    struct app *b = window_app();
    prefs_load(b);
    CHECK(strcmp(b->stt_url, "https://whisper.example/v1") == 0);
    CHECK(strcmp(b->stt_token, "sk-not-a-real-key-8842") == 0);
    CHECK(strcmp(b->voice_source, "pulse:default") == 0);
    CHECK(b->inline_media_enabled && b->inline_media_peers);
    CHECK(!b->animate_media);

    /* A value never set stays unset rather than coming back as whatever
     * the listing would have DISPLAYED for it: setting_value substitutes a
     * discovered binary for stt.local and a derived path for bot.dir, and
     * storing either would freeze a probe result into an explicit
     * preference. */
    CHECK(b->stt_local[0] == 0);
    CHECK(b->bot_dir[0] == 0);

    /* llm.* is llm.conf's business — writing it here too would give one
     * value two files to disagree from. */
    char path[512];
    snprintf(path, sizeof(path), "%s/.local/share/shottino/shottino.conf", home);
    FILE *f = fopen(path, "r");
    CHECK(f != NULL);
    char buf[4096];
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    buf[n] = 0;
    fclose(f);
    CHECK(strstr(buf, "llm.") == NULL);
    CHECK(strstr(buf, "stt.token = sk-not-a-real-key-8842") != NULL);

    /* 0600: the token is in clear in there. */
    struct stat st;
    CHECK(stat(path, &st) == 0);
    CHECK_LONG(st.st_mode & 0777, 0600);

    unlink(path);
    free_app(a);
    free_app(b);
    if (saved) setenv("HOME", saved, 1);
    else unsetenv("HOME");
    free(saved);
}

TEST(a_standing_grant_survives_a_restart) {
    char dir[] = "/tmp/shottino-grants-test-XXXXXX";
    CHECK(mkdtemp(dir) != NULL);

    struct app *a = window_app();
    snprintf(a->bot_dir, sizeof(a->bot_dir), "%s", dir);
    bot_grant_add(a, "alice", "send_message");
    bot_grant_add(a, "bob", "join_channel");
    CHECK(a->bot_grant_count == 2);

    /* A second client, same identity: it reads what the first wrote. */
    struct app *b = window_app();
    snprintf(b->bot_dir, sizeof(b->bot_dir), "%s", dir);
    bot_grants_load(b);
    CHECK(b->bot_grant_count == 2);
    CHECK(bot_has_grant(b, "alice", "send_message"));
    CHECK(bot_has_grant(b, "bob", "join_channel"));
    /* Still per PAIR after a round trip — the property that matters. */
    CHECK(!bot_has_grant(b, "alice", "join_channel"));
    CHECK(!bot_has_grant(b, "bob", "send_message"));
    /* And still a nick MATCH, not a spelling. */
    CHECK(bot_has_grant(b, "ALICE", "send_message"));

    /* A revoke reaches the file too, or the grant comes back tomorrow. */
    for (size_t i = 0; i < a->bot_grant_count; i++) {
        if (strcmp(a->bot_grants[i].nick, "alice") != 0) continue;
        memmove(a->bot_grants + i, a->bot_grants + i + 1,
                sizeof(a->bot_grants[0]) * (a->bot_grant_count - i - 1));
        a->bot_grant_count--;
        break;
    }
    bot_grants_save(a);
    struct app *c = window_app();
    snprintf(c->bot_dir, sizeof(c->bot_dir), "%s", dir);
    bot_grants_load(c);
    CHECK(c->bot_grant_count == 1);
    CHECK(!bot_has_grant(c, "alice", "send_message"));
    CHECK(bot_has_grant(c, "bob", "join_channel"));

    /* A line naming a tool this build does not have authorises nothing,
     * so it must not be shown as an authorisation. */
    char path[512];
    snprintf(path, sizeof(path), "%s/grants", dir);
    FILE *f = fopen(path, "w");
    CHECK(f != NULL);
    fprintf(f, "# comment\n\nmallory rm_minus_rf\ncarol names\n");
    fclose(f);
    struct app *d = window_app();
    snprintf(d->bot_dir, sizeof(d->bot_dir), "%s", dir);
    bot_grants_load(d);
    CHECK(d->bot_grant_count == 1);
    CHECK(bot_has_grant(d, "carol", "names"));
    CHECK(!bot_has_grant(d, "mallory", "rm_minus_rf"));

    unlink(path);
    rmdir(dir);
    /* free_app, not free: loading dropped a grant and SAID so, and a
     * logged line is an allocation. */
    free_app(a);
    free_app(b);
    free_app(c);
    free_app(d);
}

/* Tab-completion appends a space to the verb it inserts. 36 arms of the
 * dispatcher match with an exact strcmp, so every argument-less verb in
 * the client used to answer "unknown command: /video" — with an
 * invisible space in it, which is what made the message look like a lie.
 *
 * Driven through handle_command, the door every keystroke and every
 * alias goes through, so this covers verbs nobody has written yet. */
/* A channel key is the server's own parameter, not part of the name.
 *
 * `/join #chan key` used to put the whole rest in the name, so the POST
 * asked for a channel literally called "#chan key" — which grappa
 * validates and rejects, so a keyed join failed with HTTP 400 while
 * /help advertised the form. */
TEST(a_join_key_is_split_from_the_channel) {
    char chan[MAX_CHANNEL], key[MAX_LINE];

    join_split("#sniffo segreto", chan, sizeof(chan), key, sizeof(key));
    CHECK_STR(chan, "#sniffo");
    CHECK_STR(key, "segreto");

    /* No key is an empty key, not a missing split. */
    join_split("#sniffo", chan, sizeof(chan), key, sizeof(key));
    CHECK_STR(chan, "#sniffo");
    CHECK_STR(key, "");

    /* Extra spaces belong to neither. */
    join_split("  #sniffo   segreto", chan, sizeof(chan), key, sizeof(key));
    CHECK_STR(chan, "#sniffo");
    CHECK_STR(key, "segreto");

    /* A comma-separated list is still ONE name — grappa validates it. */
    join_split("#uno,#due", chan, sizeof(chan), key, sizeof(key));
    CHECK_STR(chan, "#uno,#due");
    CHECK_STR(key, "");

    /* A key with a space in it is not a thing IRC has: everything after
     * the first gap is the key, spaces and all, and the server decides. */
    join_split("#chan a b", chan, sizeof(chan), key, sizeof(key));
    CHECK_STR(chan, "#chan");
    CHECK_STR(key, "a b");
}

/* A verb is a whole word, not a prefix.
 *
 * /who matched with a bare strncmp, so a bare /whois — which the
 * with-argument arm above it does not accept — fell through to it AND
 * brought an argument: the target was read from line + 5, so /whois
 * asked the server to list a channel called "s" and /whowas one called
 * "was". Silent, plausible, and wrong. */
TEST(a_verb_is_matched_as_a_whole_word_not_a_prefix) {
    struct app *app = window_app();
    app->url.base[0] = 0;
    add_window_ex(app, "azzurra", "#sniffo", true);

    /* Bare, they explain themselves rather than becoming another verb. */
    handle_command(app, "/whois");
    CHECK(log_has(app, "/whois <nick>"));
    handle_command(app, "/whowas");
    CHECK(log_has(app, "/whowas <nick>"));

    /* Neither may reach /who — which, not being connected, would have
     * complained about the websocket instead. */
    CHECK(!log_has(app, "not connected"));

    /* A typo is an unknown verb, not a NAMES for a channel called "oo". */
    handle_command(app, "/namesfoo");
    CHECK(log_has(app, "unknown command"));

    /* With an argument they still work — the point is the boundary, not
     * refusing everything. Both reach the socket and report it missing. */
    handle_command(app, "/whois alice");
    CHECK(log_has(app, "not connected"));

    free_app(app);
}

/* All three spellings of the window verb reach the same window.
 *
 * The argument used to be found by indexing fixed offsets off a guess:
 * `line[2] == 'w'` is true for NO spelling (index 2 is 'n' in /window,
 * 'i' in /win, and the space in /w), so `/w 3` fell through to
 * `line + 8` — four bytes past the end of the string, reading whatever
 * was left in the buffer. Usually atoi found garbage and /w looked
 * simply dead; occasionally it found a number and moved somewhere
 * nobody asked for. */
TEST(every_spelling_of_the_window_verb_finds_its_number) {
    struct app *app = window_app();
    app->url.base[0] = 0;
    add_window_ex(app, "azzurra", "$server", false);
    add_window_ex(app, "azzurra", "#sniffo", true);
    add_window_ex(app, "azzurra", "#terzo", true);
    CHECK_LONG(app->window_count, 3);

    handle_command(app, "/window 2");
    CHECK_LONG(focused_window_locked(app), 1);
    handle_command(app, "/win 3");
    CHECK_LONG(focused_window_locked(app), 2);
    handle_command(app, "/w 1");
    CHECK_LONG(focused_window_locked(app), 0);

    /* Extra spaces are still the same request. */
    handle_command(app, "/w   2");
    CHECK_LONG(focused_window_locked(app), 1);

    /* A number nobody has stays where it is rather than guessing. */
    handle_command(app, "/w 99");
    CHECK_LONG(focused_window_locked(app), 1);

    free_app(app);
}

TEST(a_tab_completed_verb_still_dispatches) {
    struct app *app = window_app();
    app->url.base[0] = 0; /* nothing here should reach the network */

    /* The exact string completion produces for `/vid<TAB>`. Reaching
     * the recorder means it matched; ffmpeg is absent under test, so it
     * refuses for a reason that is NOT "unknown command". */
    handle_command(app, "/video ");
    CHECK(!log_has(app, "unknown command"));

    handle_command(app, "/voicemsg ");
    CHECK(!log_has(app, "unknown command"));
    handle_command(app, "/vmsg ");
    CHECK(!log_has(app, "unknown command"));

    /* Not just the new verbs: this was every argument-less verb in the
     * client. */
    handle_command(app, "/help ");
    CHECK(!log_has(app, "unknown command"));

    /* Several spaces, and a tab, are still "no arguments". */
    handle_command(app, "/help    ");
    CHECK(!log_has(app, "unknown command"));

    /* And a verb that really is unknown still says so — the trim must
     * not turn the error into silence. */
    handle_command(app, "/vidyo ");
    CHECK(log_has(app, "unknown command"));

    free_app(app);
}

/* The panel and /set must show the SAME set of preferences. A panel that
 * lists its own hand-written subset is a panel that quietly stops
 * mentioning whatever was added last. */
TEST(the_settings_panel_lists_every_setting) {
    struct app *app = window_app();
    app->panel = PANEL_SETTINGS;
    /* A secret worth masking: llm_token_redacted renders an EMPTY token
     * as visibly empty, so an unset one proves nothing about masking. */
    snprintf(app->llm.token, sizeof(app->llm.token), "sk-not-a-real-key-8842");
    settings_rows(app);

    CHECK(app->panel_line_count == settings_count());
    CHECK(settings_count() > 10); /* a table that emptied itself is not a pass */

    for (size_t i = 0; i < settings_count(); i++) {
        /* Every row names its setting and shows a value — not "?" , the
         * shape the admin panel used to render before #the-values-fix. */
        CHECK(strstr(app->panel_lines[i], SETTINGS[i].name) != NULL);
        CHECK(strstr(app->panel_lines[i], SETTINGS[i].help) != NULL);
    }

    /* A secret is masked in the panel exactly as it is in the listing:
     * the panel is drawn on a screen people share. */
    for (size_t i = 0; i < settings_count(); i++) {
        if (strcmp(SETTINGS[i].name, "llm.token") != 0) continue;
        CHECK(strstr(app->panel_lines[i], "*") != NULL);
        CHECK(strstr(app->panel_lines[i], "sk-not") == NULL);
    }

    /* An edit is reflected in place — the panel does not re-fetch to
     * show that a switch moved. */
    size_t mouse_row = settings_count();
    for (size_t i = 0; i < settings_count(); i++)
        if (strcmp(SETTINGS[i].name, "mouse") == 0) mouse_row = i;
    CHECK(mouse_row < settings_count());
    /* Row 0 is a VALID position for the block, and the refresh must work
     * there: treating zero as "no block" is the bug this pins. */
    CHECK(app->settings_row0 == 0);
    CHECK(app->settings_shown);
    app->mouse_enabled = !app->mouse_enabled;
    settings_rows_refresh_locked(app);
    CHECK(strstr(app->panel_lines[mouse_row], app->mouse_enabled ? "on" : "off") != NULL);

    free_app(app);
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
    RUN(a_ping_reply_is_matched_against_the_pings_we_are_waiting_on);
    RUN(a_backfilled_ping_reply_still_reports_its_round_trip);
    RUN(a_ping_reply_routed_to_server_still_lands_in_the_active_window);
    RUN(an_unsolicited_ping_reply_is_never_reported_as_our_round_trip);
    RUN(an_inbound_ctcp_query_is_named_not_dumped);
    RUN(a_ctcp_query_is_answered_only_where_it_is_ours_to_answer);
    RUN(a_ctcp_query_is_framed_the_way_the_protocol_expects);
    RUN(audio_is_classified_before_the_uploads_heuristic);
    RUN(the_admin_sessions_tab_reads_the_shape_the_server_sends);
    RUN(the_admin_uploads_tab_totals_the_bytes_field);
    RUN(the_admin_visitors_tab_renders_per_network_rows);
    RUN(a_setting_name_and_a_boolean_are_parsed_the_way_people_type_them);
    RUN(the_settings_listing_never_prints_the_token);
    RUN(a_nick_match_alone_is_never_the_owner);
    RUN(a_grant_is_per_person_and_per_tool);
    RUN(a_memory_filename_is_built_not_taken);
    RUN(two_identities_get_two_bot_directories);
    RUN(an_accented_character_survives_typing_and_one_backspace);
    RUN(a_websocket_ref_is_never_handed_out_twice);
    RUN(the_model_thread_announces_that_it_stopped);
    RUN(retiring_an_echo_moves_every_row_not_just_its_text);
    RUN(a_conversation_reaches_the_bot_and_a_join_does_not);
    RUN(a_preference_survives_a_restart);
    RUN(a_standing_grant_survives_a_restart);
    RUN(a_join_key_is_split_from_the_channel);
    RUN(a_verb_is_matched_as_a_whole_word_not_a_prefix);
    RUN(every_spelling_of_the_window_verb_finds_its_number);
    RUN(a_tab_completed_verb_still_dispatches);
    RUN(the_settings_panel_lists_every_setting);
    RUN(a_ping_reply_we_did_not_time_is_still_shown_when_live);
    return test_report();
}
