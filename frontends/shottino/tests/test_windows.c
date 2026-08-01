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
    RUN(a_ping_reply_we_did_not_time_is_still_shown_when_live);
    return test_report();
}
