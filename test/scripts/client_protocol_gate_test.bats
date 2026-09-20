#!/usr/bin/env bats
#
# scripts/client-protocol-gate.sh — every client event kind has a doc entry
# (issue 2260).
#
# The gate's whole job is to fail when a `kind` the server emits has no entry
# in `docs/CLIENT_PROTOCOL.md`, so this suite's job is to prove it CAN fail —
# and, more sharply, that it fails for the right reason.
#
# 🔴 THE ORACLE IS THE PROSE CASE, NOT A MISSING NAME.
#
# The subject under test is a document that discusses its own vocabulary. A
# substring gate would read `docs/CLIENT_PROTOCOL.md`'s own sentence "unlike
# `topic_changed`, …" as evidence that `topic_changed` is documented, and
# report a kind as covered when it has no entry. So the load-bearing case here
# is NOT "delete every trace of a kind and watch it go red" — that passes for a
# gate which is useless. It is: **delete the ENTRY, leave the PROSE standing,
# and require red.** `session_identity_changed` is the fixture because the
# document genuinely names it outside the table, in the §4 JSON example, so the
# prose that must fail to save it is real prose and not something this file
# planted.
#
# The mutations run against a COPY. The gate takes the document path as its
# one argument precisely so a case can judge a mutated file without writing to
# the tree — a suite that mutated the real document would leave the repository
# dirty on any failure between the mutation and the restore.

load ../bats_helpers

setup() {
    GATE="$BATS_TEST_DIRNAME/../../scripts/client-protocol-gate.sh"
    REPO="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    DOC="$REPO/docs/CLIENT_PROTOCOL.md"
    COPY="$BATS_TEST_TMPDIR/CLIENT_PROTOCOL.md"
    cp "$DOC" "$COPY"
}

# The gate derives its kind set from `cicchetto/src/lib/wireTypes.ts`, whose
# path it resolves relative to the working directory, so every case runs from
# the repo root.
run_gate() {
    cd "$REPO" || return 1
    run "$GATE" "$@"
}

@test "the committed document satisfies the gate" {
    run_gate "$DOC"
    [ "$status" -eq 0 ]
    [[ "$output" == *"client event kinds have an entry"* ]]
}

@test "the gate reports a plausible number of kinds, not a handful" {
    # Guards the failure mode where the derivation quietly matches almost
    # nothing and the gate announces success over an empty set. The floor is
    # deliberately well below the real count (56 at the time of writing) so
    # ordinary additions do not churn this test; it is a smoke alarm, not a pin.
    run_gate "$DOC"
    [ "$status" -eq 0 ]
    n="$(printf '%s' "$output" | sed -n 's/.*all \([0-9]*\) client event kinds.*/\1/p')"
    [ -n "$n" ]
    [ "$n" -ge 40 ]
}

@test "a kind whose ENTRY is deleted fails even though the PROSE still names it" {
    # The case the gate exists for. `session_identity_changed` keeps its §4
    # JSON example; only the inventory row goes.
    grep -c 'session_identity_changed' "$COPY" >/dev/null

    awk '!/^\| `session_identity_changed` \|/' "$COPY" > "$COPY.mut"
    mv "$COPY.mut" "$COPY"

    # Precondition, asserted rather than assumed: the entry is gone AND the
    # prose survives. Without this the case could pass by deleting everything.
    [ "$(grep -c '^| `session_identity_changed` |' "$COPY")" -eq 0 ]
    [ "$(grep -c 'session_identity_changed' "$COPY")" -ge 1 ]

    run_gate "$COPY"
    [ "$status" -eq 1 ]
    [[ "$output" == *"session_identity_changed"* ]]
    [[ "$output" == *"no entry in"* ]]
}

@test "restoring the entry turns it green again" {
    # The other arm. A red that cannot be cleared by putting the row back is
    # not evidence the row is what the gate read.
    awk '!/^\| `session_identity_changed` \|/' "$COPY" > "$COPY.mut"
    mv "$COPY.mut" "$COPY"
    run_gate "$COPY"
    [ "$status" -eq 1 ]

    cp "$DOC" "$COPY"
    run_gate "$COPY"
    [ "$status" -eq 0 ]
}

@test "a document with no inventory table names THAT defect, not 56 missing kinds" {
    # Deleting the table header must not degrade into a wall of per-kind
    # complaints: the operator needs to be told the section is gone, which is
    # one edit, rather than handed 56 symptoms of it.
    grep -v '^| `kind` | topic | what it is |$' "$COPY" > "$COPY.mut"
    mv "$COPY.mut" "$COPY"

    run_gate "$COPY"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no inventory table header"* ]]
}

@test "a missing document fails loudly instead of reporting zero drift" {
    run_gate "$BATS_TEST_TMPDIR/does-not-exist.md"
    [ "$status" -eq 1 ]
    [[ "$output" == *"missing"* ]]
}

@test "parted is NOT documented as an emitted kind" {
    # Issue 2260's table listed `parted` among the undocumented kinds. It is
    # not emitted at all: `session/server.ex` and `session/window_state.ex`
    # both say "there is intentionally NO `kind: \"parted\"` broadcast —
    # absence is the signal", and the regex that built that table matched
    # those very comments. Documenting it would put a lie in the protocol, so
    # the absence of a row is load-bearing and this pins it.
    cd "$REPO" || return 1
    [ "$(grep -c '^| `parted` |' "$DOC")" -eq 0 ]
    [ "$(git grep -cE 'kind: :parted' -- lib | wc -l | tr -d ' ')" -eq 0 ]
}
