/* test_keys — what the client does with the bytes a terminal sends.
 *
 * Every key bug in shottino so far has been a DELIVERY bug, not a
 * handler bug: the roster was bound to KEY_SPREVIOUS, which most
 * terminfo entries never define, so the key arrived as an undecoded
 * escape burst and the list never moved. Reasoning about that from the
 * source is how it shipped twice.
 *
 * So this suite writes the actual bytes into a pty and asks getch()
 * what came out, through the client's own decode path — define_pane_keys()
 * plus resolve_escape(). Two terminfo entries matter and they fail
 * differently:
 *
 *   xterm-256color  describes modified arrows, so ncurses decodes them
 *                   and our define_key() has to WIN over what terminfo
 *                   already bound;
 *   screen-256color describes none of them, so the bytes fall through
 *                   to resolve_escape() — the case that used to type
 *                   "1;5A" into the input line.
 *
 * A host without a pty, or without those entries, skips rather than
 * fails: the suite asserts shottino's decoding, not the host's
 * terminal database. */
#define main shottino_main_unused
#include "../shottino.c"
#undef main

#include "test.h"
#include <pty.h>

/* Feed one sequence and read back the single key it should become.
 * Anything left in the queue afterwards is reported by the caller: a
 * sequence that decodes to a key PLUS four stray bytes is the bug this
 * file exists for, and "the first code was right" would hide it. */
static int decode(int mfd, size_t *leftover) {
    int ch = getch();
    if (ch == 27) ch = resolve_escape();
    *leftover = 0;
    while (getch() != ERR) (*leftover)++;
    (void)mfd;
    return ch;
}

struct expectation {
    const char *name;
    const char *seq;
    int code;
};

static void run_expectations(const char *term, const struct expectation *cases, size_t n) {
    int mfd, sfd;
    if (openpty(&mfd, &sfd, NULL, NULL, NULL) != 0) {
        fprintf(stderr, "test_keys: no pty — skipping %s\n", term);
        return;
    }
    FILE *in = fdopen(sfd, "r+");
    FILE *out = fdopen(dup(sfd), "w");
    SCREEN *screen = in && out ? newterm(term, out, in) : NULL;
    if (!screen) {
        fprintf(stderr, "test_keys: no terminfo for %s — skipping\n", term);
        close(mfd);
        return;
    }
    cbreak();
    noecho();
    keypad(stdscr, TRUE);
    define_pane_keys();
    timeout(200);

    for (size_t i = 0; i < n; i++) {
        size_t leftover = 0;
        ssize_t w = write(mfd, cases[i].seq, strlen(cases[i].seq));
        (void)w;
        usleep(20000);
        int got = decode(mfd, &leftover);
        if (got != cases[i].code || leftover != 0)
            fprintf(stderr, "  %s/%s: got %d (want %d), %zu bytes left over\n", term,
                    cases[i].name, got, cases[i].code, leftover);
        CHECK_LONG(got, cases[i].code);
        /* Nothing may be left behind. Leftover bytes do not vanish —
         * they are typed into the input line. */
        CHECK_LONG((long)leftover, 0);
    }
    endwin();
    delscreen(screen);
    close(mfd);
}

/* The same sequences must mean the same thing whether terminfo
 * describes them or not. */
static const struct expectation MODIFIED_KEYS[] = {
    {"Ctrl-Shift-Up",   "\033[1;6A", KEY_ROSTER_UP},
    {"Ctrl-Shift-Down", "\033[1;6B", KEY_ROSTER_DOWN},
    {"Shift-Up",        "\033[1;2A", KEY_ROSTER_UP},
    {"Shift-Down",      "\033[1;2B", KEY_ROSTER_DOWN},
    {"Shift-PgUp",      "\033[5;2~", KEY_ROSTER_UP},
    {"Shift-PgDn",      "\033[6;2~", KEY_ROSTER_DOWN},
    {"Ctrl-Up",         "\033[1;5A", KEY_CHAT_UP},
    {"Ctrl-Down",       "\033[1;5B", KEY_CHAT_DOWN},
    {"Ctrl-Alt-Up",     "\033[1;7A", KEY_PANE_PREV},
    {"Ctrl-Alt-Down",   "\033[1;7B", KEY_PANE_NEXT},
    {"Alt-Up",          "\033[1;3A", KEY_PANE_PREV},
    {"Alt-Down",        "\033[1;3B", KEY_PANE_NEXT},
    {"plain Up",        "\033[A",    KEY_UP},
    {"plain Down",      "\033[B",    KEY_DOWN},
};

TEST(modified_keys_decode_where_terminfo_describes_them) {
    run_expectations("xterm-256color", MODIFIED_KEYS,
                     sizeof(MODIFIED_KEYS) / sizeof(MODIFIED_KEYS[0]));
}

TEST(modified_keys_decode_where_terminfo_describes_nothing) {
    /* screen/tmux: ncurses knows none of these sequences, so they reach
     * resolve_escape() as raw bytes. Before it read the sequence to its
     * end, the ESC was eaten and "1;5A" was typed into the input. */
    run_expectations("screen-256color", MODIFIED_KEYS,
                     sizeof(MODIFIED_KEYS) / sizeof(MODIFIED_KEYS[0]));
}

/* The member list only holds the keyboard when it is asked to, and
 * hands it straight back to anything that is not a movement. */
TEST(roster_focus_takes_the_arrows_and_gives_them_back) {
    struct app *app = calloc(1, sizeof(*app));
    CHECK(app != NULL);
    if (!app) return;
    pthread_mutex_init(&app->lock, NULL);
    struct window *w = &app->windows[app->window_count++];
    snprintf(w->network, sizeof(w->network), "%s", "azzurra");
    snprintf(w->channel, sizeof(w->channel), "%s", "#chan");
    w->member_count = 40;
    app->pane_count = 1;

    /* Without focus the arrows belong to the input history. */
    CHECK(!roster_key(app, KEY_UP));
    CHECK(!roster_key(app, KEY_DOWN));

    CHECK(roster_key(app, 21)); /* Ctrl-U */
    CHECK(app->roster_focus);
    CHECK(roster_key(app, KEY_DOWN));
    CHECK_LONG(app->panes[0].member_offset, 1);
    CHECK(roster_key(app, KEY_NPAGE));
    CHECK_LONG(app->panes[0].member_offset, 11);
    CHECK(roster_key(app, KEY_UP));
    CHECK_LONG(app->panes[0].member_offset, 10);
    CHECK(roster_key(app, KEY_HOME));
    CHECK_LONG(app->panes[0].member_offset, 0);

    /* Escape leaves the mode and does nothing else. */
    CHECK(roster_key(app, 27));
    CHECK(!app->roster_focus);

    /* Typing while focused is not swallowed: the mode ends and the key
     * goes on to be handled as usual, so there is nothing to get stuck
     * in. */
    CHECK(roster_key(app, 21));
    CHECK(app->roster_focus);
    CHECK(!roster_key(app, 'a'));
    CHECK(!app->roster_focus);

    /* A window with no members has no list to focus. */
    w->member_count = 0;
    CHECK(roster_key(app, 21));
    CHECK(!app->roster_focus);

    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    pthread_mutex_destroy(&app->lock);
    free(app);
}

int main(void) {
    RUN(modified_keys_decode_where_terminfo_describes_them);
    RUN(modified_keys_decode_where_terminfo_describes_nothing);
    RUN(roster_focus_takes_the_arrows_and_gives_them_back);
    return test_report();
}
