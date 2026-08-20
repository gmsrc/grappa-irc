#!/usr/bin/env bash
# scripts/union-rebase.sh — rebase, and PROVE the union driver rewrote nothing
# (#1432).
#
# Usage:
#   scripts/union-rebase.sh              # rebase onto origin/main
#   scripts/union-rebase.sh <onto-ref>   # rebase onto another ref
#
# WHAT IT GUARDS
#
# `docs/DESIGN_NOTES.md` carries `merge=union` (#114) so concurrent appends
# auto-resolve. The driver takes the additions from BOTH sides and NEVER the
# deletions, and it rewrites the boundary between entries. That gives two
# failure modes with OPPOSITE signs, both silent:
#
#   EATEN (#1271/#1428)   the identical leading prefix of two entries is
#                         aligned as a common addition and emitted once, so one
#                         entry loses its separator. Additions go DOWN.
#   RESURRECTED (#1432)   a branch that predates a commit which deliberately
#                         REMOVED text gets that text put back, glued wherever
#                         the driver lands it. Additions go UP.
#
# Both report `rc=0`, zero conflicts and zero deletions. A check that only asks
# "did we lose lines?" passes the second one cleanly, which is why the
# invariant is TWO-SIDED: additions UNCHANGED **and** deletions ZERO. Any drift
# in EITHER direction means the driver rewrote something nobody asked it to.
#
# WHY THIS IS A VERB AND NOT A CHECK IN design-notes-gate.sh
#
# The gate can read three states: HEAD's file, the base ref's file, and their
# merge base. Measured, in the resurrection regime:
#
#   PRE-rebase    merge base != base ref   lines the base deleted: 2
#   POST-rebase   merge base == base ref   lines the base deleted: 0
#
# After the rebase the merge base collapses onto the base ref, and with it the
# only state that records that a line was ever deleted. A resurrected line and
# a deliberately re-added line are then the same bytes in the same three
# states — nothing is left to tell them apart. So the detector cannot live in
# the gate: it needs a BEFORE and an AFTER, and this wrapper is the only place
# that has both. The gate stays what it is, a preventer that runs on one state.
#
# WHAT IT DOES NOT CLAIM
#
# It compares NUMSTAT, never geometry. In a scratch fixture the resurrection
# reproduces only when the deleted block is immediately adjacent to the
# branch's own append (gap=0; one line of separation and the 3-way merge sees
# two non-overlapping hunks). But the real 2026-08-16 occurrence does NOT have
# that geometry — there the deleted region sits ~59 lines before the file's
# end, and `git blame` puts those 59 lines in the same commit as the deleted
# text. So the adjacency threshold is A path to resurrection, not established
# as THE one. This tool therefore promises no threshold: it pins the numbers
# and compares them.
#
# The paths it watches are DERIVED from `.gitattributes` (`merge=union`), not
# hard-coded, so a future union-attributed file inherits this for free.
#
# Exit 0 = the rebase ran and every union-attributed path came through with its
#          contribution intact.
# Exit 1 = drift in either direction, a refused precondition, or a rebase that
#          stopped. A tool that cannot measure FAILS; it never passes vacuously.

set -euo pipefail

ONTO="${1:-origin/main}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

die() {
	printf 'union-rebase: %s\n' "$*" >&2
	exit 1
}

say() { printf 'union-rebase: %s\n' "$*"; }

# ── preconditions ───────────────────────────────────────────────────────────

git rev-parse --verify --quiet "${ONTO}^{commit}" >/dev/null \
	|| die "'$ONTO' does not resolve. If this is CI, the checkout is shallow — actions/checkout needs fetch-depth: 0."

[ -z "$(git status --porcelain)" ] \
	|| die "working tree is not clean. A rebase would refuse anyway, and a pin taken over uncommitted work measures the wrong thing."

git rev-parse --verify --quiet HEAD >/dev/null || die "HEAD does not resolve"

# ── the paths this file's own attributes put under the union driver ─────────

mapfile -t UNION_PATHS < <(
	git ls-files | git check-attr --stdin merge \
		| sed -n 's/^\(.*\): merge: union$/\1/p'
)

if [ "${#UNION_PATHS[@]}" -eq 0 ]; then
	die "no path carries merge=union — this tool would measure nothing, so it refuses rather than report a clean rebase it did not verify."
fi

# ── the pin ─────────────────────────────────────────────────────────────────

# Additions and deletions of the branch's own contribution for one path, as
# "<add> <del>". An untouched path is a real 0 0, not an absence.
pin() {
	local base="$1" head="$2" path="$3" out
	out="$(git diff --numstat "$base" "$head" -- "$path" | cut -f1,2 | tr '\t' ' ')"
	[ -n "$out" ] || out="0 0"
	printf '%s\n' "$out"
}

# Known-answer control, INSIDE the tool. A diff of a commit against itself is
# 0 0 by definition; if the parser cannot produce that, it is reading the wrong
# columns and every number below would be furniture. Exit WITHOUT a verdict.
control="$(pin HEAD HEAD "${UNION_PATHS[0]}")"
[ "$control" = "0 0" ] || die "CONTROL FAILED: pinning HEAD against itself gave '$control', expected '0 0' — the numstat parser is wrong, no verdict printed."

base_before="$(git merge-base "$ONTO" HEAD)" || die "no merge base between '$ONTO' and HEAD"
pre_head="$(git rev-parse HEAD)"

if [ "$base_before" = "$(git rev-parse "$ONTO")" ]; then
	say "already on top of $ONTO — the driver gets no chance to run, so the comparison below is VACUOUS by construction, not a pass."
fi

declare -a BEFORE
for i in "${!UNION_PATHS[@]}"; do
	BEFORE[i]="$(pin "$base_before" HEAD "${UNION_PATHS[i]}")"
done

say "pinned ${#UNION_PATHS[@]} union path(s) against $base_before; pre-rebase HEAD is $pre_head"

# ── the rebase ──────────────────────────────────────────────────────────────

if ! git rebase "$ONTO"; then
	{
		printf 'union-rebase: the rebase stopped — resolve it, then re-run this tool.\n'
		printf 'No verdict is given: the pin taken before is meaningless against a\n'
		printf 'half-applied state. Your pre-rebase HEAD was %s.\n' "$pre_head"
	} >&2
	exit 1
fi

# ── the comparison ──────────────────────────────────────────────────────────

base_after="$(git merge-base "$ONTO" HEAD)" || die "no merge base after the rebase"

status=0
for i in "${!UNION_PATHS[@]}"; do
	path="${UNION_PATHS[i]}"
	read -r add_before del_before <<<"${BEFORE[i]}"
	read -r add_after del_after <<<"$(pin "$base_after" HEAD "$path")"

	if [ "$add_before" -eq "$add_after" ] && [ "$del_after" -eq 0 ]; then
		say "$path: +$add_after -$del_after — contribution intact"
		continue
	fi

	status=1
	{
		printf 'union-rebase: %s was REWRITTEN by the merge driver.\n' "$path"
		printf '  additions %s -> %s   deletions %s -> %s\n' \
			"$add_before" "$add_after" "$del_before" "$del_after"
		if [ "$add_after" -lt "$add_before" ]; then
			printf '  additions went DOWN: the driver ATE %s line(s) (#1271/#1428).\n' \
				"$((add_before - add_after))"
			printf '  Usually the separator block of an entry whose leading prefix was\n'
			printf '  identical to the one that landed next to it. Restore it IN the commit\n'
			printf '  that carries the entry, never as a separator-only commit, and give the\n'
			printf '  entry a marker no other entry and no entry on %s carries.\n' "$ONTO"
		elif [ "$add_after" -gt "$add_before" ]; then
			printf '  additions went UP: the driver RESURRECTED %s line(s) (#1432).\n' \
				"$((add_after - add_before))"
			printf '  union takes the additions from both sides and never the deletions, so\n'
			printf '  text %s deliberately removed is back, glued wherever it landed.\n' "$ONTO"
		fi
		if [ "$del_after" -ne 0 ]; then
			printf '  deletions are %s, not zero: this branch now removes lines from %s.\n' \
				"$del_after" "$ONTO"
		fi
		printf '\n  Read the BOUNDARY SHAPE on the file before trusting any repair — an\n'
		printf '  identical numstat proves nothing if the pre-rebase state was already\n'
		printf '  broken. Your pre-rebase HEAD was %s:\n' "$pre_head"
		printf '      git reset --hard %s\n' "$pre_head"
	} >&2
done

if [ "$status" -ne 0 ]; then
	exit 1
fi

say "rebased onto $ONTO; every union path came through unchanged."
