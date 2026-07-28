/* test_layout — the chat area's clipping contract.
 *
 * The one suite that does NOT link a leaf module: it compiles shottino.c
 * itself (with `main` renamed away) and drives the real drawing functions
 * against an offscreen ncurses screen, reading the result back out of the
 * virtual screen with mvinch(). No TTY is involved — newterm() renders to
 * /dev/null and the assertions read stdscr, which is pure memory.
 *
 * It exists because every layout bug in this client has been ONE bug: the
 * measuring pass and the draw pass disagreeing about how many rows
 * something occupies, always paid for by the newest message at the bottom
 * of the region. The property asserted here is the one that makes partial
 * scrolling safe — drawing a row from its `skip`-th display line must
 * produce exactly what a full draw puts on those same lines. Anything
 * else means the row reflows as it scrolls off, and the height the
 * measuring pass computed stops describing what is drawn.
 *
 * shottino.c has no other test target: the socket, the event dispatch and
 * the app state need a live server. Keep this suite to functions that are
 * pure given a screen. */
#define main shottino_main_unused
#include "../shottino.c"
#undef main

#include "test.h"

enum { MAX_W = 120, MAX_H = 64 };

static char full_rows[MAX_H][MAX_W + 1];
static char part_rows[MAX_H][MAX_W + 1];

static void snap(char dst[MAX_H][MAX_W + 1], int rows, int cols) {
    for (int y = 0; y < rows && y < MAX_H; y++) {
        for (int x = 0; x < cols && x < MAX_W; x++) dst[y][x] = (char)(mvinch(y, x) & A_CHARTEXT);
        dst[y][cols < MAX_W ? cols : MAX_W] = '\0';
    }
}

/* The tail of a wrapped body, drawn from line `skip`, is the full draw's
 * lines `skip`.. — same break points, same cells. */
static void check_text_tail(const char *s, int width, int height, int skip) {
    erase();
    draw_wrapped_text(0, 0, width, 0, height, CP_MAIN, 0, s);
    snap(full_rows, height, width);
    erase();
    draw_wrapped_text(0, 0, width, skip, height - skip, CP_MAIN, 0, s);
    snap(part_rows, height - skip, width);
    for (int y = 0; y + skip < height; y++) CHECK_STR(part_rows[y], full_rows[y + skip]);
}

/* Same for a whole log row, which additionally owns a timestamp and
 * `<nick>` on its FIRST line only: a tail must reproduce the continuation
 * lines, header and all, exactly where the full draw put them. */
static void check_msg_tail(const char *line, int width, int height, int skip) {
    erase();
    draw_message_line(0, 0, width, 0, height, line, false, false);
    snap(full_rows, height, width);
    erase();
    draw_message_line(0, 0, width, skip, height - skip, line, false, false);
    snap(part_rows, height - skip, width);
    for (int y = 0; y + skip < height; y++) CHECK_STR(part_rows[y], full_rows[y + skip]);
}

static const char *const BODIES[] = {
    "the quick brown fox jumps over the lazy dog and keeps going well past the wrap "
    "point so that this body occupies a good handful of display lines",
    /* mIRC formatting: the run walker must be walked from the start even
     * when its early runs land on skipped lines, or the tail loses the
     * colour it inherits. */
    "\x02" "bold start\x0F plain then \x03" "04,08coloured text that wraps across more "
    "than one display line to exercise the run walker end to end",
    /* Embedded newlines break lines without filling the width. */
    "first line\nsecond line that is long enough to wrap on its own once or twice\nthird",
    "\xc3\xa8 accented bytes \xc3\xa0 \xc3\xb9 repeated until this wraps a few times over "
    "so the byte-wise wrap is exercised too",
};

TEST(wrapped_text_tail_matches_full_draw) {
    for (size_t b = 0; b < sizeof(BODIES) / sizeof(BODIES[0]); b++) {
        for (int width = 12; width <= 40; width += 7) {
            int h = wrapped_text_lines_visible(BODIES[b], width);
            if (h > MAX_H) h = MAX_H;
            for (int skip = 0; skip < h; skip++) check_text_tail(BODIES[b], width, h, skip);
        }
    }
}

TEST(message_line_tail_matches_full_draw) {
    static const char *const LINES[] = {
        "[azzurra/#chan] 12:34 <someone> a message long enough to wrap over several "
        "lines in a narrow pane, which is the whole point of this check",
        "[azzurra/#chan] 12:34 --> someone has joined",
        "[azzurra/#chan] 12:34 <someone> https://example.net/a/very/long/link/that/wraps/"
        "around/the/pane/edge/more/than/once/for/sure.png",
    };
    for (size_t l = 0; l < sizeof(LINES) / sizeof(LINES[0]); l++) {
        for (int width = 30; width <= 60; width += 10) {
            int h = message_display_lines(LINES[l], width);
            if (h > MAX_H) h = MAX_H;
            for (int skip = 0; skip < h; skip++) check_msg_tail(LINES[l], width, h, skip);
        }
    }
}

/* A skip of zero must leave the ordinary path byte-identical — the
 * parameter is a clip, not a reflow. */
TEST(zero_skip_is_the_ordinary_draw) {
    const char *line = "[azzurra/#chan] 12:34 <someone> plain and short";
    erase();
    draw_message_line(0, 0, 60, 0, 3, line, false, false);
    snap(full_rows, 3, 60);
    CHECK(strstr(full_rows[0], "<someone>") != NULL);
    CHECK(strstr(full_rows[0], "plain and short") != NULL);
}

/* The header belongs to the row's first line; a tail must not repeat it. */
TEST(tail_omits_the_nick_header) {
    const char *line = "[azzurra/#chan] 12:34 <someone> a message long enough to wrap over "
                       "several lines in a narrow pane so a tail exists at all";
    int h = message_display_lines(line, 40);
    CHECK(h > 1);
    erase();
    draw_message_line(0, 0, 40, 1, h - 1, line, false, false);
    snap(part_rows, h - 1, 40);
    CHECK(strstr(part_rows[0], "<someone>") == NULL);
    CHECK(strstr(part_rows[0], "12:34") == NULL);
}

/* ── Roster tiers ──────────────────────────────────────────────────────
 *
 * The member list is ordered and labelled off PREFIX SIGILS, because
 * that is what the wire carries. It used to test mode LETTERS, which
 * matches nothing a server sends: every member ranked plain, the roster
 * never tiered, and no sigil was ever drawn beside a nick. These pin the
 * representation so that cannot come back silently. */
static struct app *test_app(void) {
    struct app *app = calloc(1, sizeof(*app));
    if (!app) return NULL;
    pthread_mutex_init(&app->lock, NULL);
    return app;
}

static void add_test_network(struct app *app, const char *slug, const char *letters,
                             const char *sigils) {
    struct network *n = &app->networks[app->network_count++];
    snprintf(n->slug, sizeof(n->slug), "%s", slug);
    n->prefix_count = 0;
    for (size_t i = 0; letters[i] && sigils[i]; i++) {
        n->prefix_letters[n->prefix_count] = letters[i];
        n->prefix_sigils[n->prefix_count] = sigils[i];
        n->prefix_count++;
    }
}

static struct window *add_test_window(struct app *app, const char *net, const char *chan) {
    struct window *w = &app->windows[app->window_count++];
    snprintf(w->network, sizeof(w->network), "%s", net);
    snprintf(w->channel, sizeof(w->channel), "%s", chan);
    return w;
}

static void seed(struct window *w, size_t i, const char *nick, const char *modes) {
    snprintf(w->members[i].nick, sizeof(w->members[i].nick), "%s", nick);
    snprintf(w->members[i].modes, sizeof(w->members[i].modes), "%s", modes);
}

TEST(member_tiers_read_prefix_sigils_not_mode_letters) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");

    CHECK_LONG(member_rank_locked(app, "azzurra", "@"), 0);
    CHECK_LONG(member_rank_locked(app, "azzurra", "%"), 1);
    CHECK_LONG(member_rank_locked(app, "azzurra", "+"), 2);
    CHECK_LONG(member_rank_locked(app, "azzurra", ""), 3);
    /* A member holding several sigils tiers by the highest. */
    CHECK_LONG(member_rank_locked(app, "azzurra", "@+"), 0);
    /* The mode LETTER is not a sigil: 'o' must NOT read as an op. */
    CHECK_LONG(member_rank_locked(app, "azzurra", "o"), 3);

    CHECK_LONG(member_sigil_locked(app, "azzurra", "@"), '@');
    CHECK_LONG(member_sigil_locked(app, "azzurra", "+"), '+');
    CHECK_LONG(member_sigil_locked(app, "azzurra", ""), 0);
    CHECK_STR(member_rank_label_locked(app, "azzurra", "@"), "op");
    CHECK_STR(member_rank_label_locked(app, "azzurra", "%"), "halfop");
    CHECK_STR(member_rank_label_locked(app, "azzurra", "+"), "voice");
    CHECK_STR(member_rank_label_locked(app, "azzurra", ""), "user");

    /* Before 005 lands there is no PREFIX for the network: the
     * conventional ~&@%+ map still has to tier, or every roster drawn
     * during connect is flat. */
    CHECK_LONG(member_rank_locked(app, "unknown-net", "@"), 2);
    CHECK_LONG(member_sigil_locked(app, "unknown-net", "@"), '@');

    pthread_mutex_destroy(&app->lock);
    free(app);
}

TEST(roster_sorts_by_tier_then_nick) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");
    struct window *w = add_test_window(app, "azzurra", "#chan");
    seed(w, 0, "zoe", "");
    seed(w, 1, "Bob", "@");
    seed(w, 2, "alice", "+");
    seed(w, 3, "Carol", "@");
    seed(w, 4, "dave", "");
    seed(w, 5, "mod", "%");
    w->member_count = 6;
    sort_members_locked(app, "azzurra", w->members, w->member_count);

    CHECK_STR(w->members[0].nick, "Bob");
    CHECK_STR(w->members[1].nick, "Carol");
    CHECK_STR(w->members[2].nick, "mod");
    CHECK_STR(w->members[3].nick, "alice");
    CHECK_STR(w->members[4].nick, "dave");
    CHECK_STR(w->members[5].nick, "zoe");

    pthread_mutex_destroy(&app->lock);
    free(app);
}

TEST(roster_edits_keep_the_order_and_the_prefixes) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");
    struct window *w = add_test_window(app, "azzurra", "#chan");
    seed(w, 0, "Bob", "@");
    seed(w, 1, "alice", "");
    w->member_count = 2;

    CHECK(roster_add_locked(w, "zoe"));
    CHECK(!roster_add_locked(w, "ZOE")); /* already here, folded */
    sort_members_locked(app, "azzurra", w->members, w->member_count);
    CHECK_LONG(w->member_count, 3);
    CHECK_STR(w->members[0].nick, "Bob");
    CHECK_STR(w->members[1].nick, "alice");
    CHECK_STR(w->members[2].nick, "zoe");

    /* A rename keeps the prefix: an op stays an op across a NICK. */
    CHECK(roster_rename_locked(w, "Bob", "Roberto"));
    CHECK_STR(w->members[0].nick, "Roberto");
    CHECK_STR(w->members[0].modes, "@");

    CHECK(roster_remove_locked(w, "ALICE"));
    CHECK(!roster_remove_locked(w, "nobody"));
    CHECK_LONG(w->member_count, 2);
    CHECK_STR(w->members[0].nick, "Roberto");
    CHECK_STR(w->members[1].nick, "zoe");

    pthread_mutex_destroy(&app->lock);
    free(app);
}

TEST(muted_tier_needs_a_known_plus_m) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    struct window *w = add_test_window(app, "azzurra", "#chan");
    /* Never been told is NOT "not moderated": the label is only claimed
     * when the modes are actually known. */
    CHECK(!channel_is_moderated(w));
    w->chan_modes_known = true;
    snprintf(w->chan_modes, sizeof(w->chan_modes), "nt");
    CHECK(!channel_is_moderated(w));
    snprintf(w->chan_modes, sizeof(w->chan_modes), "nmt");
    CHECK(channel_is_moderated(w));
    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* The pane reserves one row per member plus a separator above the muted
 * group — measured by the same walk that draws, so the scroll bound and
 * the drawing cannot disagree. */
TEST(roster_rows_count_the_muted_separator) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");
    struct window *w = add_test_window(app, "azzurra", "#chan");
    seed(w, 0, "Bob", "@");
    seed(w, 1, "alice", "");
    seed(w, 2, "zoe", "");
    w->member_count = 3;

    CHECK_LONG(draw_member_list(app, w, -1, 0, 0, 0, 0), 3);
    w->chan_modes_known = true;
    snprintf(w->chan_modes, sizeof(w->chan_modes), "nmt");
    CHECK_LONG(draw_member_list(app, w, -1, 0, 0, 0, 0), 4); /* + separator */
    /* Everyone opped under +m: nobody is muted, so no separator row. */
    seed(w, 1, "alice", "@");
    seed(w, 2, "zoe", "@");
    CHECK_LONG(draw_member_list(app, w, -1, 0, 0, 0, 0), 3);

    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* The focused window's identity is COPIED out under the lock. Handing
 * back a pointer into app->windows let the socket thread rewrite the
 * string, or /win move app->current, between the call and the use. */
TEST(current_window_key_copies_and_reports_absence) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    char net[MAX_SLUG], chan[MAX_CHANNEL];

    /* No windows: false, and the buffers are emptied rather than left
     * holding whatever the caller had on the stack — a caller that
     * ignores the return must not send a payload naming garbage. */
    snprintf(net, sizeof(net), "stale");
    snprintf(chan, sizeof(chan), "#stale");
    CHECK(!current_window_key(app, net, sizeof(net), chan, sizeof(chan)));
    CHECK_STR(net, "");
    CHECK_STR(chan, "");

    add_test_window(app, "azzurra", "#one");
    add_test_window(app, "azzurra", "#two");
    focused_pane_locked(app)->window = 1;
    CHECK(current_window_key(app, net, sizeof(net), chan, sizeof(chan)));
    CHECK_STR(net, "azzurra");
    CHECK_STR(chan, "#two");

    /* It is a COPY: moving focus does not rewrite what the caller holds. */
    focused_pane_locked(app)->window = 0;
    CHECK_STR(chan, "#two");

    /* Either buffer may be omitted. */
    CHECK(current_window_key(app, NULL, 0, chan, sizeof(chan)));
    CHECK_STR(chan, "#one");
    CHECK(current_window_key(app, net, sizeof(net), NULL, 0));
    CHECK_STR(net, "azzurra");

    /* current is out of range (a window closed under us): reported as
     * absent, not read past the end of the array. */
    focused_pane_locked(app)->window = 7;
    CHECK(!current_window_key(app, net, sizeof(net), chan, sizeof(chan)));

    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* ── Panes ────────────────────────────────────────────────────────────
 *
 * "The current window" is derived from the focused pane rather than
 * stored beside it, and every pane holds an INDEX into a window array
 * that shifts when a window closes. Both are the kind of thing that
 * looks right until the second pane exists. */
TEST(focus_is_derived_from_the_focused_pane) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_window(app, "azzurra", "#one");
    add_test_window(app, "azzurra", "#two");

    /* No panes configured yet: asking creates the one-pane case rather
     * than reading past the end of the array. */
    CHECK_LONG(app->pane_count, 0);
    CHECK_LONG(focused_window_locked(app), 0);
    CHECK_LONG(app->pane_count, 1);

    app->panes[1] = (struct pane){.window = 1, .weight = 1};
    app->pane_count = 2;
    app->focus = 1;
    CHECK_LONG(focused_window_locked(app), 1);
    CHECK(window_is_visible_locked(app, 0));
    CHECK(window_is_visible_locked(app, 1));

    app->panes[1].window = 0;
    CHECK(window_is_visible_locked(app, 0));
    CHECK(!window_is_visible_locked(app, 1)); /* nothing shows it now */

    /* Focus beyond the pane count is clamped, not trusted. */
    app->focus = 9;
    CHECK_LONG(focused_window_locked(app), 0);
    CHECK_LONG(app->focus, 1);

    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* Closing a window shifts the array under EVERY pane, not just the
 * focused one — a pane left holding the old index silently starts
 * showing its neighbour. */
TEST(closing_a_window_renumbers_every_pane) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_window(app, "azzurra", "#a");
    add_test_window(app, "azzurra", "#b");
    add_test_window(app, "azzurra", "#c");
    app->panes[0] = (struct pane){.window = 0, .weight = 1};
    app->panes[1] = (struct pane){.window = 2, .weight = 1, .scroll_offset = 5};
    app->pane_count = 2;
    app->focus = 0;

    /* Close #b, which sits BETWEEN them: the pane on #c must follow it
     * down to index 1, not keep pointing at 2 (now past the end). */
    remove_window(app, "azzurra", "#b");
    CHECK_LONG(app->window_count, 2);
    CHECK_LONG(app->panes[0].window, 0);
    CHECK_LONG(app->panes[1].window, 1);
    CHECK_STR(app->windows[app->panes[1].window].channel, "#c");
    /* A pane whose window survived keeps its scroll position. */
    CHECK_LONG(app->panes[1].scroll_offset, 5);

    /* Close the window a pane is ON: its view resets rather than
     * inheriting whatever slid into that index. */
    remove_window(app, "azzurra", "#c");
    CHECK_LONG(app->window_count, 1);
    CHECK_LONG(app->panes[1].window, 0);
    CHECK_LONG(app->panes[1].scroll_offset, 0);

    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* ── Overlay ──────────────────────────────────────────────────────────
 *
 * The right-click menu and the Ctrl-R picker share one item builder, and
 * the draw and the activation both call it. If it ever returned a
 * different list to those two callers, Enter would act on the row above
 * the one highlighted — so the builder is what gets pinned. */
static void seed_log(struct app *app, const char *line) {
    app->log[app->log_count] = strdup(line);
    app->log_mentions[app->log_count] = false;
    app->log_pending[app->log_count] = false;
    app->log_ids[app->log_count] = 0;
    app->log_media[app->log_count] = -1;
    app->log_count++;
}

TEST(menu_offers_reply_and_query_for_the_clicked_nick) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    struct overlay_item items[64];

    app->overlay.kind = OVERLAY_MENU;
    snprintf(app->overlay.nick, sizeof(app->overlay.nick), "alice");
    CHECK_LONG(overlay_items(app, items, 64), 2);
    CHECK_STR(items[0].label, "Reply to alice");
    CHECK_LONG(items[0].action, ACT_REPLY);
    CHECK_STR(items[1].label, "Open query with alice");
    CHECK_LONG(items[1].action, ACT_QUERY);
    CHECK_STR(items[1].nick, "alice");

    /* No nick — a join row, a server notice — offers nothing rather than
     * a menu that acts on "". */
    app->overlay.nick[0] = 0;
    CHECK_LONG(overlay_items(app, items, 64), 0);

    pthread_mutex_destroy(&app->lock);
    free(app);
}

TEST(reply_picker_lists_newest_first_and_filters) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");
    add_test_window(app, "azzurra", "#chan");
    add_test_window(app, "azzurra", "#other");
    struct overlay_item items[64];

    seed_log(app, "[azzurra/#chan] 10:00 <alice> first thing");
    seed_log(app, "[azzurra/#chan] 10:01 <bob> a reply about coffee");
    seed_log(app, "[azzurra/#chan] 10:02 --> carol has joined");
    seed_log(app, "[azzurra/#other] 10:03 <dave> different channel");
    seed_log(app, "[azzurra/#chan] 10:04 <carol> last word");

    app->overlay.kind = OVERLAY_REPLY;
    size_t n = overlay_items(app, items, 64);
    /* Newest first, this window only, and the join row is not something
     * you can reply to. */
    CHECK_LONG(n, 3);
    CHECK_STR(items[0].nick, "carol");
    CHECK_STR(items[1].nick, "bob");
    CHECK_STR(items[2].nick, "alice");

    /* The filter matches a nick... */
    snprintf(app->overlay.filter, sizeof(app->overlay.filter), "ali");
    CHECK_LONG(overlay_items(app, items, 64), 1);
    CHECK_STR(items[0].nick, "alice");

    /* ...or the message text, which is how you find a line whose author
     * you have forgotten. */
    snprintf(app->overlay.filter, sizeof(app->overlay.filter), "coffee");
    CHECK_LONG(overlay_items(app, items, 64), 1);
    CHECK_STR(items[0].nick, "bob");

    snprintf(app->overlay.filter, sizeof(app->overlay.filter), "zzz");
    CHECK_LONG(overlay_items(app, items, 64), 0);

    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    pthread_mutex_destroy(&app->lock);
    free(app);
}

TEST(reply_picker_collapses_a_run_of_one_nick) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");
    add_test_window(app, "azzurra", "#chan");
    struct overlay_item items[64];
    seed_log(app, "[azzurra/#chan] 10:00 <alice> one");
    seed_log(app, "[azzurra/#chan] 10:01 <bob> two");
    seed_log(app, "[azzurra/#chan] 10:02 <bob> three");
    seed_log(app, "[azzurra/#chan] 10:03 <bob> four");
    app->overlay.kind = OVERLAY_REPLY;
    size_t n = overlay_items(app, items, 64);
    /* bob said three things in a row; the picker offers his most recent
     * and alice's, not a wall of one name. */
    CHECK_LONG(n, 2);
    CHECK_STR(items[0].nick, "bob");
    CHECK(strstr(items[0].label, "four") != NULL);
    CHECK_STR(items[1].nick, "alice");
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    pthread_mutex_destroy(&app->lock);
    free(app);
}

TEST(reply_cites_the_original_and_keeps_what_was_typed) {
    char out[MAX_LINE];

    /* IRC has no threading, so the reply carries a piece of what it
     * answers: nick, citation, then your words. */
    compose_reply("alice", "the meeting is at four", "", out, sizeof(out));
    CHECK_STR(out, "alice: \xc2\xab" "the meeting is at four\xc2\xbb ");

    /* A half-written answer survives the citation being added. */
    compose_reply("alice", "the meeting is at four", "ok, see you there", out, sizeof(out));
    CHECK_STR(out, "alice: \xc2\xab" "the meeting is at four\xc2\xbb ok, see you there");

    /* Picking a DIFFERENT message replaces the citation instead of
     * stacking a second one, and still keeps the answer. */
    char again[MAX_LINE];
    compose_reply("alice", "actually make it five", out, again, sizeof(again));
    CHECK_STR(again, "alice: \xc2\xab" "actually make it five\xc2\xbb ok, see you there");

    /* Replying to someone else re-addresses it. */
    compose_reply("bob", "who is bringing the cake", again, out, sizeof(out));
    CHECK_STR(out, "bob: \xc2\xab" "who is bringing the cake\xc2\xbb ok, see you there");

    /* No body (a row with nothing to cite) is the plain address. */
    compose_reply("carol", "", "", out, sizeof(out));
    CHECK_STR(out, "carol: ");
}

TEST(reply_citation_is_flattened_and_cut_on_a_word) {
    char out[MAX_LINE];

    /* Formatting codes are not a citation. */
    compose_reply("alice", "\x02" "bold\x0f and \x03" "04red\x0f text", "", out, sizeof(out));
    CHECK_STR(out, "alice: \xc2\xab" "bold and red text\xc2\xbb ");

    /* Newlines and runs of spaces collapse: a citation is one line. */
    compose_reply("alice", "two\n\nlines   and    spaces", "", out, sizeof(out));
    CHECK_STR(out, "alice: \xc2\xab" "two lines and spaces\xc2\xbb ");

    /* Long originals are cut on a word boundary and say they were cut. */
    compose_reply("alice",
                  "this original message is quite a lot longer than the citation limit allows",
                  "", out, sizeof(out));
    CHECK(strstr(out, "\xe2\x80\xa6\xc2\xbb ") != NULL);   /* ends with an ellipsis */
    CHECK(strlen(out) < 80);
    CHECK(strstr(out, "this original message is quite") != NULL);
    /* Cut BETWEEN words, so the citation never ends mid-word. */
    const char *open = strstr(out, "\xc2\xab");
    const char *close = strstr(out, "\xe2\x80\xa6");
    CHECK(open && close && close > open);
    CHECK(close[-1] != ' ');

    /* A body that is exactly short enough is NOT marked as cut. */
    compose_reply("alice", "short enough", "", out, sizeof(out));
    CHECK(strstr(out, "\xe2\x80\xa6") == NULL);
}

TEST(reply_leaves_a_line_it_did_not_write_alone) {
    char out[MAX_LINE];
    /* "10:30 meeting: bring the thing" is a sentence, not a reply prefix
     * this function wrote — guessing wrong here eats someone's line. */
    compose_reply("alice", "yes", "10:30 meeting: bring the thing", out, sizeof(out));
    CHECK(strstr(out, "10:30 meeting: bring the thing") != NULL);
}

/* The roster pane honours its scroll offset. The keys that drive it are
 * a terminal question, but "the offset moves the list" is not. */
TEST(roster_pane_draws_from_the_offset) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");
    struct window *w = add_test_window(app, "azzurra", "#chan");
    seed(w, 0, "aa", "@");
    seed(w, 1, "bb", "");
    seed(w, 2, "cc", "");
    seed(w, 3, "dd", "");
    w->member_count = 4;

    erase();
    draw_member_list(app, w, 0, 0, 12, 2, 0);
    snap(full_rows, 2, 12);
    CHECK(strstr(full_rows[0], "aa") != NULL);
    CHECK(strstr(full_rows[1], "bb") != NULL);

    /* Scrolled by two, the same box shows the next pair. */
    erase();
    draw_member_list(app, w, 0, 0, 12, 2, 2);
    snap(part_rows, 2, 12);
    CHECK(strstr(part_rows[0], "cc") != NULL);
    CHECK(strstr(part_rows[1], "dd") != NULL);
    CHECK(strstr(part_rows[0], "aa") == NULL);

    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* ── The decoder decides what animates ────────────────────────────────
 *
 * This one runs the REAL ffmpeg, because the bug it guards is a property
 * of ffmpeg's filter graph and nothing else: the `fps` filter yields ZERO
 * frames for a single still image (it has no duration to sample), so
 * asking for frames that way silently broke every static picture, while
 * NOT asking meant an animated GIF whose URL did not end in .gif sat
 * there as one frame. Skipped, not failed, where ffmpeg is absent. */
static bool have_ffmpeg(void) {
    return system("ffmpeg -version >/dev/null 2>&1") == 0;
}

static int decode_frames(struct app *app, const char *path, media_protocol proto, bool anim) {
    app->inline_media_enabled = true; /* or the claim declines before ffmpeg runs */
    int slot = media_claim_locked(app, path, media_kind_of(path) == MEDIA_VIDEO);
    if (slot < 0) return -1;
    media_fit_cells(4, 3, 24, 8, &app->media[slot].cols, &app->media[slot].rows);
    app->media[slot].state = IM_FETCHING;
    app->proto = proto;
    app->animate_media = anim;
    media_decode_job(app, slot);
    int n = app->media[slot].state == IM_READY ? (int)app->media[slot].frame_count : -1;
    free(app->media[slot].rgb);
    free(app->media[slot].payload);
    app->media[slot].rgb = NULL;
    app->media[slot].payload = NULL;
    return n;
}

TEST(the_decoder_says_what_animates_not_the_url) {
    if (!have_ffmpeg()) {
        fprintf(stderr, "test_layout: no ffmpeg — skipping decode checks\n");
        return;
    }
    char dir[] = "/tmp/shottino-test-XXXXXX";
    if (!mkdtemp(dir)) return;
    char gif[PATH_MAX], png[PATH_MAX], cmd[PATH_MAX * 2];
    snprintf(gif, sizeof(gif), "%s/a.bin", dir);  /* no extension to hint with */
    snprintf(png, sizeof(png), "%s/s.bin", dir);
    snprintf(cmd, sizeof(cmd),
             "ffmpeg -y -loglevel error -f lavfi -i testsrc=size=32x24:rate=10:duration=1 "
             "-f gif %s >/dev/null 2>&1", gif);
    bool made_gif = system(cmd) == 0;
    snprintf(cmd, sizeof(cmd),
             "ffmpeg -y -loglevel error -f lavfi -i testsrc=size=32x24:duration=1 -frames:v 1 "
             "-f image2 -c:v png %s >/dev/null 2>&1", png);
    bool made_png = system(cmd) == 0;

    struct app *app = test_app();
    CHECK(app != NULL);
    if (app && made_gif) {
        /* An animated file whose NAME says nothing still animates on a
         * character-art terminal: the decoder is asked, not the URL. */
        CHECK(decode_frames(app, gif, MEDIA_PROTO_NONE, true) > 1);
        /* With animation off it is one frame again. */
        CHECK_LONG(decode_frames(app, gif, MEDIA_PROTO_NONE, false), 1);
    }
    if (app && made_png) {
        /* And a still stays one frame rather than vanishing — the fps
         * filter would have returned nothing at all here. */
        CHECK_LONG(decode_frames(app, png, MEDIA_PROTO_NONE, true), 1);
    }
    if (app) {
        pthread_mutex_destroy(&app->lock);
        free(app);
    }
    unlink(gif);
    unlink(png);
    rmdir(dir);
}

int main(void) {
    FILE *sink = fopen("/dev/null", "w");
    if (!sink) {
        fprintf(stderr, "test_layout: cannot open /dev/null — skipping\n");
        return 0;
    }
    /* An offscreen screen: no TTY, no terminfo beyond the entry named
     * here. A build host without terminfo skips rather than fails — the
     * suite asserts shottino's layout, not the host's terminal database. */
    if (!newterm("xterm", sink, stdin)) {
        fprintf(stderr, "test_layout: no usable terminfo entry — skipping\n");
        fclose(sink);
        return 0;
    }
    RUN(wrapped_text_tail_matches_full_draw);
    RUN(message_line_tail_matches_full_draw);
    RUN(zero_skip_is_the_ordinary_draw);
    RUN(tail_omits_the_nick_header);
    RUN(member_tiers_read_prefix_sigils_not_mode_letters);
    RUN(roster_sorts_by_tier_then_nick);
    RUN(roster_edits_keep_the_order_and_the_prefixes);
    RUN(muted_tier_needs_a_known_plus_m);
    RUN(roster_rows_count_the_muted_separator);
    RUN(current_window_key_copies_and_reports_absence);
    RUN(focus_is_derived_from_the_focused_pane);
    RUN(closing_a_window_renumbers_every_pane);
    RUN(menu_offers_reply_and_query_for_the_clicked_nick);
    RUN(reply_picker_lists_newest_first_and_filters);
    RUN(reply_picker_collapses_a_run_of_one_nick);
    RUN(reply_cites_the_original_and_keeps_what_was_typed);
    RUN(reply_citation_is_flattened_and_cut_on_a_word);
    RUN(reply_leaves_a_line_it_did_not_write_alone);
    RUN(roster_pane_draws_from_the_offset);
    RUN(the_decoder_says_what_animates_not_the_url);
    endwin();
    fclose(sink);
    return test_report();
}
