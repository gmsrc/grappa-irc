#!/usr/bin/env bats
#
# The cicchetto review scope must NAME the theme CSS, not merely cover it
# (issue 2136).
#
# `cicchetto/src/themes/default.css` grew 12,778 -> 15,513 lines in a month
# (measured on 6b8b4fe0f against the 2026-08-14 tree). Nothing caught it,
# and the reason is a property of the scope text rather than of the file: the
# cicchetto row lists the glob `cicchetto/src/**`, which technically CONTAINS
# the stylesheet while naming nothing an agent would go read. A reviewer
# dispatched on that row reads the TypeScript and stops, because the checklist
# it is handed enumerates SolidJS, TypeScript, wire shapes, XSS and a11y — and
# never mentions CSS at all. The browser is the only oracle for that file, so
# an unread stylesheet has no second line of defence.
#
# WHY A GATE AND NOT JUST THE SENTENCE
#
# The cure is one clause in a prose table, which is exactly the kind of thing
# a later edit drops without anyone noticing — the same failure mode that
# produced the finding. The assertion below is the thing that notices.
#
# TWO DOCUMENTS, AND ONLY ONE WAS BROKEN
#
# Measured before writing this: `.claude/skills/review/SKILL.md` ALREADY named
# `cicchetto/src/themes/*.css` in its scope row and already carried a CSS lens;
# `docs/reviewing.md` had ZERO occurrences of either "CSS" or "themes". So the
# issue's premise held for one of the two files and not the other. Both are
# pinned here anyway: the one that was right is the regression that would
# otherwise be silent, and a gate that only watches the file that happened to
# be broken today learns nothing general.
#
# The scope row is anchored FIRST in every case. Without that anchor a renamed
# or reformatted row would make the interesting assertion fail for the boring
# reason, and the failure message would send the next reader after the wrong
# defect.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    REVIEWING="$REPO_SRC/docs/reviewing.md"
    SKILL="$REPO_SRC/.claude/skills/review/SKILL.md"
}

# The `| cicchetto/ | ... |` row of a scope table, as one line.
scope_row() {
    grep -E '^\| cicchetto/ \|' "$1"
}

# The bullet list under the cicchetto agent's "what it looks for" lead-in,
# stopping at the next heading of any level.
#
# The lead-in is NOT a markdown heading in both files: `docs/reviewing.md`
# writes `### What the cicchetto/ agent looks for`, the skill writes the same
# sentence as plain text. Anchoring on `^#+ ` matched one and silently
# returned nothing for the other — which the `-n "$output"` guard in each
# case caught as an extraction failure rather than reporting "no CSS lens".
cicchetto_lens() {
    awk '/[Ww]hat the cicchetto\/ agent looks for/ { f = 1; next }
         f && /^#+ / { exit }
         f { print }' "$1"
}

@test "docs/reviewing.md has a cicchetto scope row at all" {
    # The anchor. Every assertion below greps INSIDE this row, so if the row
    # stops existing they would all fail for a reason that has nothing to do
    # with CSS.
    [ -f "$REVIEWING" ]
    run scope_row "$REVIEWING"
    [ "$status" -eq 0 ]
    [ -n "$output" ]
}

@test "docs/reviewing.md names the theme CSS in the cicchetto scope" {
    # The finding itself: a glob that contains the file is not a scope that
    # names it.
    run scope_row "$REVIEWING"
    [ "$status" -eq 0 ]
    [[ "$output" == *"themes/"*".css"* ]]
}

@test "docs/reviewing.md's cicchetto checklist carries a CSS lens" {
    # Naming the file in the scope buys nothing if the checklist the agent
    # works from still enumerates only TypeScript concerns: the reviewer opens
    # the stylesheet and has no question to ask of it.
    run cicchetto_lens "$REVIEWING"
    [ "$status" -eq 0 ]
    [ -n "$output" ]
    [[ "$output" == *"CSS"* ]]
}

@test "the review skill has a cicchetto scope row at all" {
    [ -f "$SKILL" ]
    run scope_row "$SKILL"
    [ "$status" -eq 0 ]
    [ -n "$output" ]
}

@test "the review skill names the theme CSS in the cicchetto scope" {
    # Already true when this gate was written. Pinned so it stays true.
    run scope_row "$SKILL"
    [ "$status" -eq 0 ]
    [[ "$output" == *"themes/"*".css"* ]]
}

@test "the review skill's cicchetto checklist carries a CSS lens" {
    run cicchetto_lens "$SKILL"
    [ "$status" -eq 0 ]
    [ -n "$output" ]
    [[ "$output" == *"CSS"* ]]
}

@test "the scope row is not satisfied by the bare src/** glob" {
    # The discriminating control. Every assertion above is a substring match,
    # and a substring match is only worth as much as its ability to REFUSE.
    # Feed it the pre-cure spelling — the glob alone, which is what the row
    # said while the file grew 21% — and require that it does NOT pass.
    #
    # Without this, a future edit that widens the pattern into something every
    # row satisfies would leave six green tests guarding nothing.
    local glob_only='| cicchetto/ | `cicchetto/src/**` + `cicchetto/{tsconfig.json,vite.config.ts}` |'
    refute test "$(printf '%s' "$glob_only" | grep -c 'themes/.*\.css')" -gt 0
}
