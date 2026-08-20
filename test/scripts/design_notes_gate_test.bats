#!/usr/bin/env bats
#
# scripts/design-notes-gate.sh — the DESIGN_NOTES entry-boundary gate (#1271).
#
# `docs/DESIGN_NOTES.md` carries `merge=union` (#114). The driver auto-resolves
# concurrent appends for the entry BODIES and silently mangles the boundary
# between them: every entry was appended with the same three leading lines
# (blank / `---` / blank), the merge machinery aligns that identical prefix as a
# COMMON addition, union emits it once and concatenates both bodies after it.
# One entry keeps its separator, the other loses it — no conflict, no markers,
# `rc=0`, ZERO deletions. Four occurrences on 2026-08-13 alone, every one caught
# only because a human pinned `git diff --numstat` before the rebase.
#
# The gate is that ritual automated, so this suite's job is to prove the gate
# can FAIL — a guard that cannot fail is not a guard.
#
# The oracle is therefore NOT a hand-written broken file. Every case below
# builds a scratch repository with the real `merge=union` attribute, appends an
# entry on each of two branches, and runs a real `git rebase`. What the gate is
# judged against is what the merge machinery actually produced. A synthetic
# fixture would prove the regex works and nothing about the defect.

load ../bats_helpers

setup() {
    GATE_SRC="$BATS_TEST_DIRNAME/../../scripts/design-notes-gate.sh"
    REAL_REPO="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
}

# Append one entry, in the shipped shape. The marker — when present — is the
# FIRST appended line, with no blank before it: measured, that shape loses
# nothing at all (8 additions before the rebase, 8 after), whereas putting a
# blank line ahead of the marker still costs that blank (9 → 8). A convention
# that routinely shrinks the diff by one line would poison the very numstat
# comparison this whole class is detected by.
#
# The marker tag is separate from the heading tag so a case can hand two
# entries the SAME marker, which is how the copy-paste is reproduced.
append_entry() {
    local tag="$1" marker="$2"
    if [ "$marker" != no ]; then
        printf '<!-- entry #%s -->\n' "$marker" >> docs/DESIGN_NOTES.md
    fi
    printf '\n---\n\n## 2026-01-02 — entry %s\n\nbody %s\n' "$tag" "$tag" \
        >> docs/DESIGN_NOTES.md
}

# A scratch repo with `merge=union` on the log, one entry already in the base,
# and one appended on each of `main` and `feat`. Leaves `feat` checked out,
# NOT yet rebased, so each case controls what happens next.
scratch() {
    local feat_marker="$1" main_marker="$2"
    REPO="$BATS_TEST_TMPDIR/repo"
    rm -rf "$REPO"
    mkdir -p "$REPO/docs" "$REPO/scripts"
    cp "$GATE_SRC" "$REPO/scripts/design-notes-gate.sh"
    chmod 0755 "$REPO/scripts/design-notes-gate.sh"

    cd "$REPO"
    git -c init.defaultBranch=main init -q .
    git config user.email bats@example.invalid
    git config user.name bats

    printf 'INTRO\n\n---\n\n## 2026-01-01 — entry A\n\nbody A\n' > docs/DESIGN_NOTES.md
    printf 'docs/DESIGN_NOTES.md merge=union\n' > .gitattributes
    git add -A
    git commit -qm base
    git branch feat

    append_entry C "$main_marker"
    git commit -qam 'main C'

    git checkout -q feat
    append_entry B "$feat_marker"
    git commit -qam 'feat B'
}

# Additions / deletions of the branch's contribution, as the pre-rebase pin.
contribution() {
    git diff --numstat main...feat -- docs/DESIGN_NOTES.md | cut -f"$1"
}

# ── The oracle: the gate fails on what the driver actually produces ──────────

@test "the gate FAILS on a separator the union driver just ate (#1271)" {
    scratch no no

    local add_before add_after del_after
    add_before="$(contribution 1)"

    run git rebase main
    [ "$status" -eq 0 ]

    add_after="$(contribution 1)"
    del_after="$(contribution 2)"

    # The loss, measured here rather than assumed — and measured as the reason
    # nothing catches it: exactly the 3-line separator block vanished while the
    # rebase reported success and deletions stayed at zero.
    [ "$del_after" -eq 0 ]
    [ "$add_after" -eq $((add_before - 3)) ]

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"NOT preceded by"* ]]
    [[ "$output" == *"entry B"* ]]
}

@test "with a marker on both sides, nothing is eaten and the gate passes (#1271)" {
    scratch B C

    local add_before add_after
    add_before="$(contribution 1)"

    run git rebase main
    [ "$status" -eq 0 ]

    add_after="$(contribution 1)"

    # Not one line lost — the marker leaves no identical prefix to collapse.
    [ "$add_after" -eq "$add_before" ]

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 0 ]
}

@test "the OTHER side's marker alone already saves the separator (#1271)" {
    # Adoption is therefore incremental: the pair is protected the moment
    # EITHER entry carries a marker, so no flag day and no sweep of old
    # entries. Measured on the side that would otherwise lose its separator —
    # `feat` here carries none.
    scratch no C

    local add_before add_after
    add_before="$(contribution 1)"

    run git rebase main
    [ "$status" -eq 0 ]

    add_after="$(contribution 1)"
    [ "$add_after" -eq "$add_before" ]

    # The gate still fails this branch, and on the OTHER finding: `feat`'s own
    # entry has no marker. What must not appear is the #1271 one — the
    # separator survived, and saying otherwise would send the next reader
    # hunting a merge that behaved.
    run scripts/design-notes-gate.sh main
    refute grep -q "NOT preceded by" <<<"$output"
}

# ── The second failure mode, kept separate from the first ───────────────────

@test "a separator with no marker is its own finding, not the #1271 one" {
    # Two causes, two messages: an eaten separator is the merge machinery, a
    # missing marker is an author who did not know the convention. Reporting
    # them as one would send the next reader looking for a rebase that never
    # happened.
    scratch no no

    # No rebase: `feat` is well formed apart from the marker.
    run scripts/design-notes-gate.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"no <!-- entry ... --> marker line"* ]]
    refute grep -q "NOT preceded by" <<<"$output"
}

@test "a DUPLICATED marker reinstates the collapse — uniqueness IS the mechanism" {
    # Both entries carry `#C`, so the identical prefix is back and so is the
    # bug — one line WORSE than before, because the marker collapses with the
    # separator block it was added to protect. Measured, not assumed: this is
    # why the gate has to check uniqueness and not merely presence.
    scratch C C

    local add_before add_after
    add_before="$(contribution 1)"

    run git rebase main
    [ "$status" -eq 0 ]

    add_after="$(contribution 1)"
    [ "$add_after" -eq $((add_before - 4)) ]

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"NOT preceded by"* ]]
}

@test "the same marker twice in one file is rejected before a merge can use it" {
    # The reachable way to get there: an author copies the previous entry's
    # block as a template and keeps its marker. No merge is involved yet, both
    # entries are perfectly well formed, and the NEXT concurrent rebase is the
    # one that pays. This is the only case that isolates the uniqueness check —
    # once the collapse has happened there is a single marker left to count.
    scratch B C
    printf '<!-- entry #B -->\n\n---\n\n## 2026-01-03 — entry D\n\nbody D\n' \
        >> docs/DESIGN_NOTES.md
    git commit -qam 'feat D, template copied from B'

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"duplicate entry marker"* ]]
    refute grep -q "NOT preceded by" <<<"$output"
}

# ── The prevention window: a marker the BASE already carries (#1428) ─────────
#
# The regime in which #1271's cure does not cure. The case above needs both
# copies in ONE file to be seen; here the branch's file carries the marker
# exactly ONCE and the base carries the other. Nothing local is duplicated, so
# the file-wide count is blind, and the collision only becomes real at the
# rebase — by which point the four lines are already gone.

@test "a marker the base already carries is rejected BEFORE the rebase (#1428)" {
    # `scratch C C` puts the SAME marker on both sides, and main's copy landed
    # AFTER the branch was cut. That is the reachable path: a rebase is exactly
    # when a previously-unique marker stops being unique.
    #
    # This case also PINS the reference. The collision does not exist at the
    # merge base — only at the base REF's tip — so a check written against the
    # merge base measures nothing and this case goes red.
    scratch C C

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"already carried by"* ]]
    [[ "$output" == *"<!-- entry #C -->"* ]]
}

@test "the pre-rebase gate is the only window: the rebase itself is silent (#1428)" {
    # What the check above is standing in front of, measured rather than
    # asserted. Left ungated, this rebase reports success, deletes nothing, and
    # takes FOUR lines — one more than carrying no marker at all, because the
    # duplicated marker collapses together with the separator block it was
    # added to protect.
    scratch C C

    local add_before add_after del_after
    add_before="$(contribution 1)"

    run git rebase main
    [ "$status" -eq 0 ]

    add_after="$(contribution 1)"
    del_after="$(contribution 2)"

    [ "$del_after" -eq 0 ]
    [ "$add_after" -eq $((add_before - 4)) ]
}

@test "a marker absent from the base passes the pre-rebase check (#1428)" {
    # The negative control for the two cases above: same shape, distinct
    # markers, no rebase. Without it, a check that simply failed every branch
    # carrying a marker would satisfy them both.
    scratch B C

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 0 ]
}

# ── Fail-closed, and the fast path that must stay honest ────────────────────

@test "an unresolvable base ref FAILS the gate, it does not skip it" {
    # The reachable version of this is a shallow CI checkout, where origin/main
    # simply is not there. Passing would report a green gate that looked at
    # nothing — the exact shape of every guard that fails open.
    scratch B C

    run scripts/design-notes-gate.sh no/such/ref
    [ "$status" -eq 1 ]
    [[ "$output" == *"does not resolve"* ]]
    [[ "$output" == *"fetch-depth"* ]]
}

@test "a branch that adds no entry says so, rather than claiming a check" {
    scratch B C
    git checkout -q main

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 0 ]
    [[ "$output" == *"adds no"* ]]
}

@test "a '## ' line inside a fenced block is sample text, not an entry" {
    # Entries quote shell and markdown constantly. Reading a fenced `## ` as a
    # heading would fail a perfectly well-formed entry and teach the next
    # author to stop quoting.
    scratch B C
    printf '\n```\n## 2026-01-02 — entry B\n```\n' >> docs/DESIGN_NOTES.md
    git commit -qam 'feat B gains a fenced sample of its own heading'
    git rebase -q main

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 0 ]
}

# ── The gate against the file it actually ships to guard ────────────────────

@test "the real docs/DESIGN_NOTES.md passes the gate on this branch" {
    # Self-referential on purpose: this branch appends an entry of its own, so
    # this case is the gate running for real against its first client.
    cd "$REAL_REPO"

    run scripts/design-notes-gate.sh
    [ "$status" -eq 0 ]
}
