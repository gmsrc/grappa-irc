#!/usr/bin/env bats
#
# scripts/union-rebase.sh — the two-sided union-drift detector (#1432).
#
# `merge=union` fails in two directions with OPPOSITE signs, both at rc=0 with
# zero conflicts and zero deletions:
#
#   EATEN (#1271/#1428)   a separator block is collapsed, additions go DOWN
#   RESURRECTED (#1432)   text the base deleted is put back, additions go UP
#
# A check that only asks "did we lose lines?" passes the second one cleanly, so
# this suite's job is to prove the tool goes red in BOTH directions and stays
# green on a rebase that behaved. A detector nobody has watched fail is not a
# detector — which is the whole subject of the issue.
#
# The oracle is never a hand-written broken file: every case builds a scratch
# repository with the real `merge=union` attribute and runs a real `git rebase`,
# so what the tool is judged against is what the merge machinery produced.

load ../bats_helpers

setup() {
    TOOL_SRC="$BATS_TEST_DIRNAME/../../scripts/union-rebase.sh"
}

# A scratch repo carrying the union attribute, `main` one commit ahead, `feat`
# with its own appended entry, NOT yet rebased.
#
#   scratch_eaten        two entries, neither with a marker -> the #1271 shape
#   scratch_resurrected  base text that main deletes, adjacent to feat's append
#   scratch_clean        distinct markers, main deletes nothing
scratch_init() {
    REPO="$BATS_TEST_TMPDIR/repo"
    rm -rf "$REPO"
    mkdir -p "$REPO/docs" "$REPO/scripts"
    cp "$TOOL_SRC" "$REPO/scripts/union-rebase.sh"
    chmod 0755 "$REPO/scripts/union-rebase.sh"
    cd "$REPO"
    git -c init.defaultBranch=main init -q .
    git config user.email bats@example.invalid
    git config user.name bats
    printf 'docs/DESIGN_NOTES.md merge=union\n' > .gitattributes
}

scratch_eaten() {
    scratch_init
    printf 'INTRO\n\n---\n\n## 2026-01-01 — entry A\n\nbody A\n' > docs/DESIGN_NOTES.md
    git add -A && git commit -qm base
    git branch feat
    printf '\n---\n\n## 2026-01-02 — entry C\n\nbody C\n' >> docs/DESIGN_NOTES.md
    git commit -qam 'main C'
    git checkout -q feat
    printf '\n---\n\n## 2026-01-02 — entry B\n\nbody B\n' >> docs/DESIGN_NOTES.md
    git commit -qam 'feat B'
}

scratch_resurrected() {
    scratch_init
    # The COST block sits at the very tail, so feat's append is adjacent to
    # what main is about to delete. Measured: that is a geometry in which the
    # driver resurrects. The tool does NOT depend on the geometry — it compares
    # numstat — but the fixture needs one that actually reproduces.
    printf 'INTRO\n\n<!-- entry #A -->\n\n---\n\n## 2026-01-01 — entry A\n\nbody A\nCOST line 1\nCOST line 2\n' \
        > docs/DESIGN_NOTES.md
    git add -A && git commit -qm base
    git branch feat
    printf 'INTRO\n\n<!-- entry #A -->\n\n---\n\n## 2026-01-01 — entry A\n\nbody A\n' \
        > docs/DESIGN_NOTES.md
    git commit -qam 'main: supersede the accepted cost'
    git checkout -q feat
    printf '<!-- entry #B -->\n\n---\n\n## 2026-01-02 — entry B\n\nbody B\n' \
        >> docs/DESIGN_NOTES.md
    git commit -qam 'feat B'
}

# A branch that DELETES from the union path — the shape `del_after == 0` could
# not express (issue 2138). Two geometries, and they disagree about everything:
#
#   scratch_deleting_clean  the removed block sits far from main's append, the
#                           3-way merge sees two non-overlapping hunks, and the
#                           deletion SURVIVES. A correct rebase.
#   scratch_deleting_eaten  the removed block is adjacent to main's append, the
#                           driver runs, and it puts the deleted text BACK.
#                           Measured: the contribution goes to an EMPTY diff.
scratch_deleting_clean() {
    scratch_init
    {
        printf 'INTRO\n\n<!-- entry #A -->\n\n---\n\n## 2026-01-01 — entry A\n\nbody A\nCOST line 1\nCOST line 2\n\n'
        for i in 1 2 3 4 5 6 7 8 9 10; do printf 'filler %s\n' "$i"; done
        printf '\n<!-- entry #Z -->\n\n---\n\n## 2026-01-01 — entry Z\n\nbody Z\n'
    } > docs/DESIGN_NOTES.md
    git add -A && git commit -qm base
    git branch feat
    printf '<!-- entry #C -->\n\n---\n\n## 2026-01-02 — entry C\n\nbody C\n' \
        >> docs/DESIGN_NOTES.md
    git commit -qam 'main C'
    git checkout -q feat
    grep -v '^COST line ' docs/DESIGN_NOTES.md > docs/DN.tmp && mv docs/DN.tmp docs/DESIGN_NOTES.md
    git commit -qam 'feat: supersede the accepted cost'
}

scratch_deleting_eaten() {
    scratch_init
    printf 'INTRO\n\n<!-- entry #A -->\n\n---\n\n## 2026-01-01 — entry A\n\nbody A\nCOST line 1\nCOST line 2\n' \
        > docs/DESIGN_NOTES.md
    git add -A && git commit -qm base
    git branch feat
    printf '<!-- entry #C -->\n\n---\n\n## 2026-01-02 — entry C\n\nbody C\n' \
        >> docs/DESIGN_NOTES.md
    git commit -qam 'main C'
    git checkout -q feat
    grep -v '^COST line ' docs/DESIGN_NOTES.md > docs/DN.tmp && mv docs/DN.tmp docs/DESIGN_NOTES.md
    git commit -qam 'feat: supersede the accepted cost'
}

scratch_clean() {
    scratch_init
    printf 'INTRO\n\n<!-- entry #A -->\n\n---\n\n## 2026-01-01 — entry A\n\nbody A\n' \
        > docs/DESIGN_NOTES.md
    git add -A && git commit -qm base
    git branch feat
    printf '<!-- entry #C -->\n\n---\n\n## 2026-01-02 — entry C\n\nbody C\n' \
        >> docs/DESIGN_NOTES.md
    git commit -qam 'main C'
    git checkout -q feat
    printf '<!-- entry #B -->\n\n---\n\n## 2026-01-02 — entry B\n\nbody B\n' \
        >> docs/DESIGN_NOTES.md
    git commit -qam 'feat B'
}

# ── the two directions ──────────────────────────────────────────────────────

@test "additions going UP is a failure: the driver RESURRECTED text (#1432)" {
    # The direction a loss-only check passes cleanly. This is the case the
    # whole tool exists for.
    scratch_resurrected

    run scripts/union-rebase.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"RESURRECTED"* ]]
    [[ "$output" == *"docs/DESIGN_NOTES.md"* ]]
    # Anchored on the phrase, not on "ATE": a bare substring match would be
    # satisfied by any future wording that happens to contain those letters.
    refute grep -q "driver ATE" <<<"$output"
}

@test "additions going DOWN is a failure: the driver ATE a separator (#1271)" {
    scratch_eaten

    run scripts/union-rebase.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"ATE"* ]]
    refute grep -q "RESURRECTED" <<<"$output"
}

@test "a rebase that behaved passes, so the two above are not a tool that always fails" {
    scratch_clean

    run scripts/union-rebase.sh main
    [ "$status" -eq 0 ]
    [[ "$output" == *"came through unchanged"* ]]
}

# ── a branch that DELETES: the verdict was inverted here (issue 2138) ───────
#
# The shipped verdict was `add_before == add_after && del_after == 0`, which
# reads deletions as damage rather than as a quantity to conserve. On a branch
# whose WORK is a deletion — the August rollover moved 44,287 lines out of the
# log — that is wrong in BOTH directions, and the second one is why this is not
# a nit:
#
#   false RED    on a correct rebase, because del_after is legitimately nonzero
#   false GREEN  when the driver EATS the deletion, because del_after becomes
#                0 and the tool says "contribution intact" about a contribution
#                that no longer exists
#
# The verifier was inverted on precisely the failure mode it exists for.

@test "a deleting branch whose deletion SURVIVED passes (issue 2138)" {
    # Geometry: the removed block is far from main's append, so the 3-way merge
    # sees two non-overlapping hunks and never consults the driver. Under
    # `del_after == 0` this correct rebase was accused.
    scratch_deleting_clean

    run scripts/union-rebase.sh main
    [ "$status" -eq 0 ]
    [[ "$output" == *"came through unchanged"* ]]
    [[ "$output" == *"-2"* ]]

    # And the deletion really is still applied — the numbers above would also
    # be produced by a tool reading the wrong two columns.
    [ "$(grep -c '^COST line ' docs/DESIGN_NOTES.md || true)" -eq 0 ]
    [ "$(grep -c 'entry C' docs/DESIGN_NOTES.md)" -eq 1 ]
}

@test "a deleting branch whose deletion the driver ATE is a failure (issue 2138)" {
    # The false-green case, and the reason the cure ships with the rollover
    # rather than behind it. Measured on this fixture: the contribution against
    # the new base is an EMPTY diff — 0 additions, 0 deletions — and the old
    # verdict read that as intact.
    scratch_deleting_eaten

    run scripts/union-rebase.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"deletions 2 -> 0"* ]]
    [[ "$output" == *"are back"* ]]

    # The damage, from the file rather than from the tool that is under test.
    [ "$(grep -c '^COST line ' docs/DESIGN_NOTES.md)" -eq 2 ]

    # Not the other diagnosis: additions did not move, and saying they did
    # would send the next reader hunting an eaten separator.
    refute grep -q "driver ATE" <<<"$output"
    refute grep -q "RESURRECTED" <<<"$output"
}

@test "the contribution going EMPTY is named, not reported as a small drift (issue 2138)" {
    # 0 and 0 is the arithmetic of "nothing of this branch survives on that
    # path", and it is the exact pair the old verdict called intact. A report
    # that prints two zeroes without saying what they mean is how it read as a
    # pass for as long as it did.
    scratch_deleting_eaten

    run scripts/union-rebase.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"EMPTY against the new base"* ]]
}

# ── the numbers, measured rather than asserted ──────────────────────────────

@test "the report carries the drift it measured, in both directions" {
    # Without this the words RESURRECTED and ATE are labels the tool could
    # print on anything. The counts come from the driver.
    scratch_resurrected
    run scripts/union-rebase.sh main
    [[ "$output" == *"additions 7 -> 9"* ]]

    scratch_eaten
    run scripts/union-rebase.sh main
    [[ "$output" == *"additions 6 -> 3"* ]]
}

@test "a failure hands back the pre-rebase HEAD, because the rebase already ran" {
    # `git rebase --abort` is gone by the time the drift is visible, so the only
    # way back is the sha the tool pinned before starting. A detector that
    # reports damage and strands you is half a tool.
    scratch_resurrected
    local pre
    pre="$(git rev-parse HEAD)"

    run scripts/union-rebase.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"git reset --hard $pre"* ]]
}

# ── fail-closed, and the fast paths that must stay honest ───────────────────

@test "no merge=union path anywhere makes the tool REFUSE, not report a clean rebase" {
    # Passing here would report a verified rebase against nothing at all — the
    # shape of every guard that fails open.
    scratch_clean
    printf '# nothing under the union driver\n' > .gitattributes
    git commit -qam 'drop the union attribute'

    run scripts/union-rebase.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"would measure nothing"* ]]
}

@test "an unresolvable onto ref FAILS the tool, it does not skip it" {
    scratch_clean

    run scripts/union-rebase.sh no/such/ref
    [ "$status" -eq 1 ]
    [[ "$output" == *"does not resolve"* ]]
    [[ "$output" == *"fetch-depth"* ]]
}

@test "a dirty tree is refused before anything is pinned" {
    scratch_clean
    printf 'uncommitted\n' >> docs/DESIGN_NOTES.md

    run scripts/union-rebase.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"not clean"* ]]
}

@test "already on top of the onto ref says the comparison is VACUOUS, not a pass" {
    # The driver never runs, so there is nothing to have rewritten. Reporting
    # that as a verified rebase is the log-honesty failure: a fast path must
    # state what it observed, not what it skipped.
    scratch_clean
    git checkout -q main

    run scripts/union-rebase.sh main
    [ "$status" -eq 0 ]
    [[ "$output" == *"VACUOUS"* ]]
}
