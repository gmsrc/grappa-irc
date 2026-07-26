/* test_alias.c — user-defined alias expansion.
 *
 * The placeholder rules have more corners than they look like they do:
 * missing positionals, $* alongside $1, the implicit-append case, and
 * recursion. Each is pinned here.
 */
#include "../alias.h"
#include "test.h"

#include <stdlib.h>

/* Expand and return the result in a static buffer, for compact asserts. */
static const char *expand(const struct alias_table *t, const char *line) {
    static char out[ALIAS_MAX_EXPANSION];
    alias_expand(t, line, out, sizeof(out));
    return out;
}

TEST(set_get_unset) {
    struct alias_table t = {0};
    CHECK(alias_set(&t, "hi", "/me waves") == ALIAS_SET_OK);
    CHECK_STR(alias_get(&t, "hi"), "/me waves");
    CHECK_LONG(t.count, 1);

    /* A leading slash on the name is accepted and stripped, so both
     * `/alias hi ...` and `/alias /hi ...` define the same alias. */
    CHECK(alias_set(&t, "/bye", "/quit later") == ALIAS_SET_OK);
    CHECK_STR(alias_get(&t, "bye"), "/quit later");
    CHECK_STR(alias_get(&t, "/bye"), "/quit later");

    /* Redefining overwrites in place rather than appending a shadow. */
    CHECK(alias_set(&t, "hi", "/me nods") == ALIAS_SET_OK);
    CHECK_STR(alias_get(&t, "hi"), "/me nods");
    CHECK_LONG(t.count, 2);

    /* Names are case-insensitive, matching the dispatcher. */
    CHECK_STR(alias_get(&t, "HI"), "/me nods");
    CHECK(alias_set(&t, "HI", "/me shrugs") == ALIAS_SET_OK);
    CHECK_LONG(t.count, 2);

    CHECK(alias_unset(&t, "hi"));
    CHECK(alias_get(&t, "hi") == NULL);
    CHECK_LONG(t.count, 1);
    CHECK(!alias_unset(&t, "hi"));
    /* The surviving entry must not have been disturbed by the removal. */
    CHECK_STR(alias_get(&t, "bye"), "/quit later");
}

/* #427 reversed the original "builtins are never shadowed" rule: an alias
 * MAY shadow any verb except /alias and /unalias. These assert the CURRENT
 * ruling; the old suite asserted its opposite, so it was rewritten rather
 * than adjusted — a test that encodes a reversed decision is worse than no
 * test, because it argues for the wrong behaviour. */
TEST(builtins_are_shadowable) {
    struct alias_table t = {0};
    const char *builtins[] = {"join", "part", "quit", "me", "msg", "mode", "w", "j", "q", "n"};
    for (size_t i = 0; i < sizeof(builtins) / sizeof(builtins[0]); i++) {
        CHECK(alias_set(&t, builtins[i], "/me hijacked") == ALIAS_SET_OK);
        CHECK(!alias_is_non_shadowable(builtins[i]));
    }
    CHECK_LONG(t.count, sizeof(builtins) / sizeof(builtins[0]));

    /* And the shadow must actually take effect at expansion time — the
     * alias wins over the builtin it shadows. Checked in a FRESH table
     * whose expansion target is not itself aliased: with `me` also
     * shadowed (as it is in `t` above) the result re-expands, which is
     * correct-but-bounded behaviour and would obscure what is under test
     * here. `chained_expansion_is_bounded` covers that case directly. */
    struct alias_table one = {0};
    CHECK(alias_set(&one, "join", "/me hijacked") == ALIAS_SET_OK);
    CHECK_STR(expand(&one, "/join #chan"), "/me hijacked #chan");

    struct alias_table two = {0};
    CHECK(alias_set(&two, "q", "/msg bob") == ALIAS_SET_OK);
    CHECK_STR(expand(&two, "/q hello"), "/msg bob hello");
}

/* The two-verb deny list: shadowing the repair surface would leave no way
 * to undo the alias from the compose line. */
TEST(alias_and_unalias_are_not_shadowable) {
    struct alias_table t = {0};
    CHECK(alias_is_non_shadowable("alias"));
    CHECK(alias_is_non_shadowable("unalias"));
    CHECK(alias_is_non_shadowable("/alias"));   /* leading slash tolerated */
    CHECK(alias_is_non_shadowable("ALIAS"));    /* case-insensitive */
    CHECK(!alias_is_non_shadowable("aliases")); /* not a prefix match */
    CHECK(!alias_is_non_shadowable(NULL));

    CHECK(alias_set(&t, "alias", "/me hijacked") == ALIAS_SET_NON_SHADOWABLE);
    CHECK(alias_set(&t, "unalias", "/me hijacked") == ALIAS_SET_NON_SHADOWABLE);
    CHECK(alias_set(&t, "/alias", "/me hijacked") == ALIAS_SET_NON_SHADOWABLE);
    CHECK_LONG(t.count, 0);

    /* Even if an entry somehow existed, expansion must refuse to apply
     * it — the define-time gate and the expander share one predicate. */
    CHECK_STR(expand(&t, "/alias x /me y"), "/alias x /me y");
    CHECK_STR(expand(&t, "/unalias x"), "/unalias x");
}

TEST(positional_placeholders) {
    struct alias_table t = {0};
    alias_set(&t, "greet", "/msg $1 hello $2");
    CHECK_STR(expand(&t, "/greet bob world"), "/msg bob hello world");

    /* A missing positional expands to empty, not to the literal "$2" —
     * a half-substituted command would be sent to the server as-is. */
    CHECK_STR(expand(&t, "/greet bob"), "/msg bob hello ");

    /* No args at all: every placeholder empties. */
    CHECK_STR(expand(&t, "/greet"), "/msg  hello ");

    /* Beyond $9 is not a placeholder; $10 reads as $1 followed by '0'. */
    alias_set(&t, "ten", "/x $10");
    CHECK_STR(expand(&t, "/ten a"), "/x a0");

    /* Repeated use of the same positional. */
    alias_set(&t, "twice", "/x $1 $1");
    CHECK_STR(expand(&t, "/twice a"), "/x a a");
}

TEST(star_placeholder) {
    struct alias_table t = {0};
    alias_set(&t, "say", "/msg #dev $*");
    CHECK_STR(expand(&t, "/say hello there world"), "/msg #dev hello there world");
    CHECK_STR(expand(&t, "/say"), "/msg #dev ");

    /* $* preserves internal spacing of the argument tail verbatim, while
     * $1 takes only the first token. */
    alias_set(&t, "both", "/x $1 [$*]");
    CHECK_STR(expand(&t, "/both a b  c"), "/x a [a b  c]");
}

/* With no placeholder in the expansion, arguments are appended — this is
 * the case that makes `/alias hi /me waves at` + `/hi bob` do the obvious
 * thing instead of silently dropping "bob". */
TEST(implicit_append) {
    struct alias_table t = {0};
    alias_set(&t, "hi", "/me waves at");
    CHECK_STR(expand(&t, "/hi bob"), "/me waves at bob");
    CHECK_STR(expand(&t, "/hi"), "/me waves at");

    /* Once ANY placeholder is present, the implicit append is off —
     * otherwise the args would appear twice. */
    alias_set(&t, "pos", "/msg $1");
    CHECK_STR(expand(&t, "/pos bob extra"), "/msg bob");
}

TEST(chained_expansion_is_bounded) {
    struct alias_table t = {0};
    /* a -> b -> /me done */
    alias_set(&t, "a", "/b");
    alias_set(&t, "b", "/me done");
    CHECK_STR(expand(&t, "/a"), "/me done");
    CHECK_LONG(alias_expand(&t, "/a", (char[ALIAS_MAX_EXPANSION]){0}, ALIAS_MAX_EXPANSION), 2);

    /* Self-reference must terminate rather than spin. */
    struct alias_table loop = {0};
    alias_set(&loop, "spin", "/spin");
    char out[ALIAS_MAX_EXPANSION];
    int applied = alias_expand(&loop, "/spin", out, sizeof(out));
    CHECK_LONG(applied, ALIAS_MAX_DEPTH);
    CHECK_STR(out, "/spin");

    /* Mutual recursion likewise. */
    struct alias_table mutual = {0};
    alias_set(&mutual, "x", "/y");
    alias_set(&mutual, "y", "/x");
    applied = alias_expand(&mutual, "/x", out, sizeof(out));
    CHECK_LONG(applied, ALIAS_MAX_DEPTH);
}

TEST(non_aliases_pass_through_untouched) {
    struct alias_table t = {0};
    alias_set(&t, "hi", "/me waves");

    /* Plain chat text is not a command and must never be rewritten. */
    CHECK_STR(expand(&t, "hello world"), "hello world");
    /* An unknown verb passes through so the dispatcher can report it. */
    CHECK_STR(expand(&t, "/nosuchverb arg"), "/nosuchverb arg");
    /* A built-in with NO alias defined passes through untouched. (With an
     * alias defined it would expand — see builtins_are_shadowable.) */
    CHECK_STR(expand(&t, "/join #chan"), "/join #chan");
    /* Bare slash, and slash-space, are not verbs. */
    CHECK_STR(expand(&t, "/"), "/");
    CHECK_STR(expand(&t, "/ x"), "/ x");
    CHECK_STR(expand(&t, ""), "");

    char out[ALIAS_MAX_EXPANSION];
    CHECK(!alias_expand_once(&t, "hello", out, sizeof(out)));
    CHECK(!alias_expand_once(&t, "/join #c", out, sizeof(out)));
    CHECK(alias_expand_once(&t, "/hi", out, sizeof(out)));
}

TEST(table_full_is_refused_not_silently_dropped) {
    struct alias_table t = {0};
    char name[32];
    for (int i = 0; i < ALIAS_MAX_ENTRIES; i++) {
        snprintf(name, sizeof(name), "a%d", i);
        CHECK(alias_set(&t, name, "/me x") == ALIAS_SET_OK);
    }
    CHECK_LONG(t.count, ALIAS_MAX_ENTRIES);
    CHECK(alias_set(&t, "overflow", "/me x") == ALIAS_SET_FULL);
    /* An existing entry can still be overwritten when the table is full. */
    CHECK(alias_set(&t, "a0", "/me y") == ALIAS_SET_OK);
    CHECK_STR(alias_get(&t, "a0"), "/me y");
}

TEST(invalid_definitions_are_refused) {
    struct alias_table t = {0};
    CHECK(alias_set(&t, "", "/me x") == ALIAS_SET_INVALID);
    CHECK(alias_set(&t, "name", "") == ALIAS_SET_INVALID);
    CHECK(alias_set(&t, NULL, "/me x") == ALIAS_SET_INVALID);
    CHECK(alias_set(&t, "name", NULL) == ALIAS_SET_INVALID);
    CHECK(alias_set(&t, "/", "/me x") == ALIAS_SET_INVALID);
    CHECK_LONG(t.count, 0);
}

/* A long expansion must truncate rather than run off the buffer. */
TEST(oversized_expansion_truncates_safely) {
    struct alias_table t = {0};
    char big[ALIAS_MAX_EXPANSION];
    memset(big, 'x', sizeof(big) - 1);
    big[sizeof(big) - 1] = '\0';
    alias_set(&t, "big", big);

    char small[32];
    alias_expand(&t, "/big", small, sizeof(small));
    CHECK(strlen(small) < sizeof(small));

    /* $* with a huge argument tail must also stay in bounds. */
    struct alias_table t2 = {0};
    alias_set(&t2, "echo", "/msg #c $*");
    char line[ALIAS_MAX_EXPANSION + 64];
    snprintf(line, sizeof(line), "/echo %s", big);
    char out[64];
    alias_expand(&t2, line, out, sizeof(out));
    CHECK(strlen(out) < sizeof(out));
}

TEST(null_safety) {
    char out[64];
    CHECK(!alias_expand_once(NULL, "/x", out, sizeof(out)));
    CHECK(!alias_expand_once(NULL, NULL, out, sizeof(out)));
    CHECK(alias_get(NULL, "x") == NULL);
    CHECK(!alias_unset(NULL, "x"));
    CHECK(!alias_is_non_shadowable(NULL));
    struct alias_table t = {0};
    CHECK_LONG(alias_expand(&t, NULL, out, sizeof(out)), 0);
    CHECK_STR(out, "");
}

int main(void) {
    RUN(set_get_unset);
    RUN(builtins_are_shadowable);
    RUN(alias_and_unalias_are_not_shadowable);
    RUN(positional_placeholders);
    RUN(star_placeholder);
    RUN(implicit_append);
    RUN(chained_expansion_is_bounded);
    RUN(non_aliases_pass_through_untouched);
    RUN(table_full_is_refused_not_silently_dropped);
    RUN(invalid_definitions_are_refused);
    RUN(oversized_expansion_truncates_safely);
    RUN(null_safety);
    return test_report();
}
