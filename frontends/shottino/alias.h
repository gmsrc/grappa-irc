/* alias.h — user-defined command aliases.
 *
 * `/alias hi /me waves at` then `/hi bob` sends the action. Grammar
 * mirrors cicchetto's (`lib/slashCommands.ts`, #385) so the two clients
 * accept the same alias definitions:
 *
 *   $1 .. $9   positional argument; a missing one expands to empty
 *   $*         all arguments, verbatim
 *   (neither)  arguments are appended to the expansion
 *
 * Built-in verbs can never be shadowed, and expansion is depth-bounded, so
 * `/alias a /a` terminates instead of spinning.
 *
 * This lives apart from shottino.c because it is pure — a table, a line in,
 * a line out. That makes it testable without a terminal, which matters:
 * the placeholder rules have more edge cases than they look like they do.
 */
#ifndef SHOTTINO_ALIAS_H
#define SHOTTINO_ALIAS_H

#include <stdbool.h>
#include <stddef.h>

#define ALIAS_MAX_NAME 64
#define ALIAS_MAX_EXPANSION 1024
#define ALIAS_MAX_ENTRIES 64
#define ALIAS_MAX_DEPTH 8

struct alias_entry {
    char name[ALIAS_MAX_NAME];
    char expansion[ALIAS_MAX_EXPANSION];
};

struct alias_table {
    struct alias_entry entries[ALIAS_MAX_ENTRIES];
    size_t count;
};

typedef enum {
    ALIAS_SET_OK,
    ALIAS_SET_BUILTIN, /* refused: name collides with a built-in verb */
    ALIAS_SET_FULL,    /* refused: table is full */
    ALIAS_SET_INVALID  /* refused: empty name or expansion */
} alias_set_result;

/* True when `verb` (no leading slash, case-insensitive) is a shottino
 * built-in. Reads the ONE built-in list, so the shadowing check cannot
 * drift from what the dispatcher actually handles. */
bool alias_is_builtin(const char *verb);

/* Define or overwrite. `name` may carry a leading '/', which is stripped. */
alias_set_result alias_set(struct alias_table *t, const char *name, const char *expansion);

/* Remove by name. Returns false when there was no such alias. */
bool alias_unset(struct alias_table *t, const char *name);

/* Look up an expansion by name, or NULL. */
const char *alias_get(const struct alias_table *t, const char *name);

/* Expand ONE layer. Returns false (leaving `out` untouched) when `line` is
 * not a slash command, names a built-in, or names no known alias. */
bool alias_expand_once(const struct alias_table *t, const char *line, char *out, size_t out_sz);

/* Expand repeatedly up to ALIAS_MAX_DEPTH. Always writes `out` (a copy of
 * `line` when nothing expanded). Returns the number of layers applied. */
int alias_expand(const struct alias_table *t, const char *line, char *out, size_t out_sz);

#endif /* SHOTTINO_ALIAS_H */
