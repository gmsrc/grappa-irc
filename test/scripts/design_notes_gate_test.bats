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

# Append one entry. The marker — when present — is the FIRST appended line,
# with no blank before it: measured on this fixture, that shape loses nothing
# at all (7 additions before the rebase, 7 after) against EITHER shape of the
# other side. A blank ahead of the marker is `lead=blank`, and what it costs
# depends on what the other branch appended: nothing against a markered entry,
# but ONE line against an entry in the legacy shape, which is most of the
# file's history. A convention that shrinks the diff by one line in some
# configurations and not others would poison the very numstat comparison this
# whole class is detected by.
#
# The marker tag is separate from the heading tag so a case can hand two
# entries the SAME marker, which is how the copy-paste is reproduced.
append_entry() {
    local tag="$1" marker="$2" lead="$3"
    if [ "$lead" = blank ]; then
        printf '\n' >> docs/DESIGN_NOTES.md
    fi
    if [ "$marker" != no ]; then
        printf '<!-- entry #%s -->\n' "$marker" >> docs/DESIGN_NOTES.md
    fi
    printf '\n---\n\n## 2026-01-02 — entry %s\n\nbody %s\n' "$tag" "$tag" \
        >> docs/DESIGN_NOTES.md
}

# An entry dated in an arbitrary month. `append_entry` pins 2026-01-02 because
# every case above judges SHAPE and the date is inert to it; the rollover check
# reads the month out of the heading, so those cases need a date they choose.
append_entry_dated() {
    local date="$1" tag="$2"
    printf '<!-- entry #%s -->\n\n---\n\n## %s — entry %s\n\nbody %s\n' \
        "$tag" "$date" "$tag" "$tag" >> docs/DESIGN_NOTES.md
}

# A scratch repo with `merge=union` on the log, one entry already in the base,
# and one appended on each of `main` and `feat`. Leaves `feat` checked out,
# NOT yet rebased, so each case controls what happens next.
#
# The third argument is the shape of `feat`'s own entry — `no` for the shipped
# one, `blank` for a stray blank line ahead of the marker. It is spelled at
# every call site rather than defaulted: which cases feed the gate a malformed
# entry is exactly what a reader needs to see without scrolling up.
scratch() {
    local feat_marker="$1" main_marker="$2" feat_lead="$3"
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

    append_entry C "$main_marker" no
    git commit -qam 'main C'

    git checkout -q feat
    append_entry B "$feat_marker" "$feat_lead"
    git commit -qam 'feat B'
}

# Additions / deletions of the branch's contribution, as the pre-rebase pin.
contribution() {
    git diff --numstat main...feat -- docs/DESIGN_NOTES.md | cut -f"$1"
}

# ── The oracle: the gate fails on what the driver actually produces ──────────

@test "the gate FAILS on a separator the union driver just ate (#1271)" {
    scratch no no no

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
    scratch B C no

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
    scratch no C no

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
    scratch no no no

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
    scratch C C no

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
    scratch B C no
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
    scratch C C no

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
    scratch C C no

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
    scratch B C no

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 0 ]
}

# ── The marker's own precondition: it is the FIRST appended line (2011) ──────
#
# The marker defeats `merge=union` by making the first appended line DIFFER
# between the two branches. A blank ahead of it hands the machinery back the
# most collidable line there is: a blank collides with every entry appended in
# the legacy shape — `\n---\n\n## ` — which is most of this file's history, and
# with every other blank-led entry.
#
# The four-line window above the heading cannot see that. The marker still sits
# at p4 and the shape those four lines spell is still exactly canonical, so the
# stray blank is at p5, outside. A COVERAGE gap, not a broken check — which is
# why the cure is a fifth line of history and not a new regex.

@test "a blank ahead of the marker is rejected BEFORE the rebase (2011)" {
    scratch B C blank

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"blank line"* ]]
    [[ "$output" == *"entry B"* ]]

    # Neither of the other two findings: the separator is there and so is the
    # marker. Reporting either would send the author editing a correct line.
    refute grep -q "NOT preceded by" <<<"$output"
    refute grep -q "no <!-- entry ... --> marker line" <<<"$output"
}

@test "left ungated, the driver eats that blank and the pin goes quiet (2011)" {
    # What the check above stands in front of, measured rather than argued.
    # `main` carries no marker here — the legacy shape, and the configuration
    # the incremental-adoption case above proves is SAFE for a canonical entry.
    # Blank-led, that same pair loses a line: the blank is not a nit, it is
    # what disarms the protection the marker exists to give.
    scratch B no blank

    local add_before add_after del_after
    add_before="$(contribution 1)"

    run git rebase main
    [ "$status" -eq 0 ]

    add_after="$(contribution 1)"
    del_after="$(contribution 2)"

    [ "$del_after" -eq 0 ]
    [ "$add_after" -eq $((add_before - 1)) ]

    # And the pre-rebase window is the ONLY one. The line the driver ate IS the
    # offending blank, so what it leaves behind is a canonical entry with
    # nothing left to find. A check moved after the rebase reports green on
    # every occurrence of this, which is the shape of a guard that arrives late.
    run scripts/design-notes-gate.sh main
    [ "$status" -eq 0 ]
}

@test "the first entry in a file has nothing above it, and that is no finding (2011)" {
    # The negative control for the case above, and the one place where "the
    # line above the marker" does not exist. awk's history variables start
    # unset, which reads as blank — so without a guard on the fifth line this
    # well formed entry is reported for a blank nobody wrote. Measured: with
    # the guard deleted the two cases above stay green and only this one goes
    # red, which is the whole reason it is here.
    scratch B C no

    # feat's entry becomes the entire file, putting its marker on line 1.
    printf '<!-- entry #E -->\n\n---\n\n## 2026-01-04 — entry E\n\nbody E\n' \
        > docs/DESIGN_NOTES.md
    git commit -qam 'feat E, and the file now begins with it'

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 0 ]
}

# ── Fail-closed, and the fast path that must stay honest ────────────────────

@test "an unresolvable base ref FAILS the gate, it does not skip it" {
    # The reachable version of this is a shallow CI checkout, where origin/main
    # simply is not there. Passing would report a green gate that looked at
    # nothing — the exact shape of every guard that fails open.
    scratch B C no

    run scripts/design-notes-gate.sh no/such/ref
    [ "$status" -eq 1 ]
    [[ "$output" == *"does not resolve"* ]]
    [[ "$output" == *"fetch-depth"* ]]
}

@test "a branch that adds no entry says so, rather than claiming a check" {
    scratch B C no
    git checkout -q main

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 0 ]
    [[ "$output" == *"adds no"* ]]
}

@test "a '## ' line inside a fenced block is sample text, not an entry" {
    # Entries quote shell and markdown constantly. Reading a fenced `## ` as a
    # heading would fail a perfectly well-formed entry and teach the next
    # author to stop quoting.
    scratch B C no
    printf '\n```\n## 2026-01-02 — entry B\n```\n' >> docs/DESIGN_NOTES.md
    git commit -qam 'feat B gains a fenced sample of its own heading'
    git rebase -q main

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 0 ]
}

# ── The rollover: a closed month must not still be inline (issue 2138) ──────
#
# `docs/DESIGN_NOTES.md` is the CURRENT month plus the undated preamble; closed
# months live in `docs/design_notes/YYYY-MM.md` (#1537). Nothing enforced that,
# so it simply stopped after July and 495 August entries stayed inline for six
# weeks without anyone noticing.
#
# "Closed" is read off the FILE and never off the clock: the newest month with
# an inline entry is the current one, everything older is closed. A wall-clock
# rule would turn main red at midnight on the 1st for work nobody did, and
# could not be tested without a time seam; this one goes red on the branch that
# opens the new month, which is both attributable and the moment the rollover
# actually falls due.

@test "a closed month still inline FAILS the gate (2138)" {
    scratch B C no
    append_entry_dated 2026-02-01 F
    git commit -qam 'feat F opens February while January is still inline'

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"closed month"* ]]
    [[ "$output" == *"2026-01"* ]]

    # The two January entries the branch can see (base A, its own B), counted
    # rather than eyeballed — and EXACTLY one month reported, which is what the
    # negative control below asserts is EXACTLY zero.
    [[ "$output" == *"2 entries"* ]]
    [ "$(grep -c 'first at line' <<<"$output")" -eq 1 ]
}

@test "the CURRENT month inline is not a finding (2138)" {
    # The negative control. A check that complained about the month the file is
    # supposed to carry would be red on every branch forever, so it would be
    # turned off within a day — and it would satisfy the case above.
    scratch B C no

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 0 ]
    [ "$(grep -c 'first at line' <<<"$output")" -eq 0 ]
    [[ "$output" == *"nothing to roll over"* ]]
}

@test "prose, an index row and a fenced sample naming a closed month are not entries (2138)" {
    # The trap this check is one line of regex away from: its subject
    # DOCUMENTS ITSELF. The rollover's own index table carries a `2025-12` row
    # forever after, the preamble names the boundary month in prose, and
    # entries quote entry headings inside fences. A matcher that reads any of
    # those is green on a broken file and red on a correct one.
    scratch B C no
    cat >> docs/DESIGN_NOTES.md <<'EOF'

Everything before **2025-12** lives in [`design_notes/`](design_notes/).

| month | file | `##` sections |
| --- | --- | --- |
| 2025-12 | [`design_notes/2025-12.md`](design_notes/2025-12.md) | 3 |

```
## 2025-12-31 — entry Z
```
EOF
    git commit -qam 'feat B gains the index that documents the convention'

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 0 ]
    [ "$(grep -c 'first at line' <<<"$output")" -eq 0 ]

    # Two-sided, on the same file: the SAME heading text outside the fence IS a
    # finding. Without this half the green above is also what a check that
    # reads nothing at all produces.
    append_entry_dated 2025-12-31 Z
    git commit -qam 'feat B, and now December really is inline'

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"2025-12"* ]]
    [ "$(grep -c 'first at line' <<<"$output")" -eq 1 ]
}

@test "the rollover check runs on a branch that adds no entry (2138)" {
    # The shape checks are diff-scoped and skip a branch that appends nothing.
    # This one must not: a stale month is a property of the FILE, every branch
    # is about to build on it, and most PRs never touch the log — gated behind
    # the diff, the enforcement would be dead exactly where the debt lives.
    scratch B C no
    git checkout -q main
    append_entry_dated 2026-02-01 F
    git commit -qam 'main F opens February'

    run scripts/design-notes-gate.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"adds no"* ]]
    [[ "$output" == *"closed month"* ]]

    # And it does not also claim the opposite. This is the only path that
    # prints the summary line next to a finding, so it is the only place the
    # "nothing to roll over" wording can contradict the check above it.
    refute grep -q "nothing to roll over" <<<"$output"
}

# ── The gate against the file it actually ships to guard ────────────────────

@test "the real docs/DESIGN_NOTES.md passes the gate on this branch" {
    # Self-referential on purpose: this branch appends an entry of its own, so
    # this case is the gate running for real against its first client.
    cd "$REAL_REPO"

    run scripts/design-notes-gate.sh
    [ "$status" -eq 0 ]
}
