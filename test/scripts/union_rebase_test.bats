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
