#!/usr/bin/env bash
# board-check.sh — orchestrator label drift-guard for the grappa.chat WIP board.
#
# WHY: the board renders from the mutually-exclusive status:* labels on
# vjt/grappa-irc. Since #1632 (vjt, 2026-08-20) there are TWO — queued / cooking
# — and the machine is `queued → cooking → closed at the MERGE`. A milestone is a
# PLANNING label (which release the work is INTENDED for), never proof that code
# is in a tag, so this script does not audit milestones. `status:soon` is RETIRED:
# the label still exists on GitHub (deleting it is vjt's call) but nothing sets
# it, so an issue still carrying one is drift and check 3 below fails on it.
# The orchestrator OWNS keeping these labels
# truthful, but the transitions are manual side-effects that are easy to forget
# (missed queued→cooking on a #273 dispatch; left status:cooking on the closed
# #268 — both caught by vjt, 2026-07-16). This script is the STANDING GUARD:
# run it at EVERY handoff-flush and EVERY /orchestrate resume. One query, right
# --limit baked in (ad-hoc `gh issue list` defaults to 30 → silently truncates
# older issues like #234, which masked drift twice).
#
# Usage: board-check.sh            # audit, print state, exit 1 on drift
#        board-check.sh --cooking N[,N...]   # ALSO assert cooking set == the
#                                            # issues you believe are in-flight
#
# Exit 0 = board is truthful. Exit 1 = DRIFT — fix BEFORE proceeding.

set -euo pipefail
REPO="vjt/grappa-irc"
LIMIT=300
drift=0

# --cooking accepts the expected in-flight set in ANY separator/order:
# comma OR space separated, #-prefixed or bare, one arg or many. We collect
# everything after the flag and normalise below — so `--cooking "#75 #291"`,
# `--cooking 75,291`, and `--cooking 291 75` are all equivalent.
expect_cooking=""
if [ "${1:-}" = "--cooking" ]; then
  shift
  expect_cooking="$*"
fi

# norm: tokenise on comma+whitespace, strip #, drop non-numeric, NUMERIC sort,
# re-prefix with #. Order-independent + separator-independent set canonicaliser.
norm() { echo "${1:-}" | tr ' ,' '\n\n' | sed 's/^#*//' | grep -E '^[0-9]+$' \
  | sort -n | sed 's/^/#/' | tr '\n' ' ' | sed 's/ *$//'; }

# 1) HARD DRIFT: no CLOSED issue may carry any status:* label (a shipped+closed
#    issue leaves the board's status columns; only the closed-link shows it).
closed_bad=$(gh issue list --repo "$REPO" --state closed --limit "$LIMIT" \
  --json number,labels \
  -q '.[] | select([.labels[].name] | any(startswith("status:")))
      | "#"+(.number|tostring)+" ["+([.labels[].name|select(startswith("status:"))]|join(","))+"]"')
if [ -n "$closed_bad" ]; then
  echo "✗ DRIFT — CLOSED issue still carrying status:* (strip it):"
  echo "$closed_bad" | sed 's/^/    /'
  drift=1
fi

# 2) HARD DRIFT: no issue may carry MORE THAN ONE status:* label (mutually excl.)
multi=$(gh issue list --repo "$REPO" --state all --limit "$LIMIT" \
  --json number,labels \
  -q '.[] | (.labels|map(.name)|map(select(startswith("status:")))) as $s
      | select(($s|length)>1) | "#"+(.number|tostring)+" ["+($s|join(","))+"]"')
if [ -n "$multi" ]; then
  echo "✗ DRIFT — issue with >1 status:* label (must be mutually exclusive):"
  echo "$multi" | sed 's/^/    /'
  drift=1
fi

# 3) HARD DRIFT: status:soon is RETIRED (#1632) — nothing sets it any more, so an
#    OPEN issue still carrying it was left behind by the old four-state machine.
#    Closed ones are already caught by check 1, so this looks at OPEN only.
retired=$(gh issue list --repo "$REPO" --state open --limit "$LIMIT" --label status:soon \
  --json number -q '[.[].number] | sort | map("#"+(tostring)) | join(" ")')
if [ -n "$retired" ]; then
  echo "✗ DRIFT — OPEN issue carrying the RETIRED status:soon label (#1632):"
  echo "    $retired"
  echo "    → the machine is queued→cooking→closed-at-merge; close it if its work"
  echo "      merged, else move it back to status:queued. Never re-add soon."
  drift=1
fi

# 4) Board snapshot (OPEN only — the two live columns).
cooking=$(gh issue list --repo "$REPO" --state open --limit "$LIMIT" --label status:cooking \
  --json number -q '[.[].number] | sort | map("#"+(tostring)) | join(" ")')
queued=$(gh issue list --repo "$REPO" --state open --limit "$LIMIT" --label status:queued \
  --json number -q '[.[].number] | sort | map("#"+(tostring)) | join(" ")')
echo "  cooking: ${cooking:-<none>}"
echo "  queued : ${queued:-<none>}"

# 5) Optional: assert cooking matches what the orchestrator believes is in-flight.
if [ -n "$expect_cooking" ]; then
  want=$(norm "$expect_cooking")
  got=$(norm "$cooking")
  if [ "$want" != "$got" ]; then
    echo "✗ DRIFT — cooking set mismatch: board has [${got:-<none>}], you expect [$want]"
    echo "    → move the missing issue(s) queued→cooking, or clear the stale cooking label."
    drift=1
  fi
fi

if [ "$drift" -eq 0 ]; then
  echo "✓ BOARD OK"
else
  echo "✗ BOARD DRIFT — fix before proceeding (see lines above)."
fi
exit "$drift"
