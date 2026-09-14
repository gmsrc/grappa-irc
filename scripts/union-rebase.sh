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
# invariant is TWO-SIDED: additions UNCHANGED **and** deletions UNCHANGED.
# Any drift in EITHER direction, on EITHER column, means the driver rewrote
# something nobody asked it to.
#
# 🔴 It read "deletions ZERO" until issue 2138, and that is not a wording slip:
# it is a quantity CONSERVED confused with a quantity FORBIDDEN, and it made
# the verifier wrong in both directions on a branch whose work is a removal.
# False RED on a correct rebase, because such a branch's del_after is
# legitimately nonzero — and, the one that matters, false GREEN when the driver
# EATS the deletion, because del_after then becomes 0 and the tool reports
# "contribution intact". Measured on the fixture the bats suite builds: the
# contribution drops to an EMPTY diff, 0 additions and 0 deletions, and the old
# rule called that intact. The verifier was inverted on precisely the failure
# mode it exists for. Found while rolling 44,287 lines of August out of the log
# — the first branch in a long time to delete in bulk from a union path, which
# is why it had never been exercised.
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
#
# 🔴 The diff algorithm is PINNED, and that is the load-bearing part of this
# function. The verdict compares two counts taken against DIFFERENT base
# files — the merge base before, the onto-ref after — so it only means
# anything if the count is a property of the CONTENT and not of the path
# git's aligner happened to take. The default (`myers`, heuristics on) is not
# that: on a branch deleting in bulk from a large file it reports a different
# pair on each side of a rebase that changed nothing.
#
# Measured, issue 2138, rebasing 7cb03ef0d onto 702834fd7 — the August
# rollover, 44,287 lines out of a 57,421-line docs/DESIGN_NOTES.md:
#
#   myers      before 156/44287   after 323/44454   <- BOTH columns +167
#   minimal    before 156/44287   after 156/44287
#   patience   before 156/44287   after 156/44287
#   histogram  before 156/44287   after 156/44287
#
# On a third pair (merge base -> post-rebase HEAD) the three stable
# algorithms all returned 648/44287, which is the arithmetic prediction
# 156 + 492 appended; myers returned 798/44437. The rebase itself was
# CORRECT: the resulting file was rebuilt byte-for-byte from its three parts
# and cmp'd clean (rc=0; rc=1 with one byte perturbed). So the RED belonged
# to the aligner, and a verifier that cries wolf on a correct rebase is one
# the next reader learns not to believe — which is how a gate dies.
#
# Pinning ONE side would be worse than pinning neither: the two numbers would
# be computed by different rules and every comparison below would be
# furniture. Both sides come through this one function, so the pin cannot be
# half-applied.
#
# NOT COVERED BY A TEST, and deliberately not faked. Two synthetic fixtures
# were built to reproduce the instability — 60,000 lines with a 45,000-line
# deletion, and 30,000 lines with a 24,000-line deletion drawn from a
# six-line vocabulary to maximise alignment ambiguity. Neither discriminates:
# myers and histogram agree on both sides of both rebases. The instance above
# is the only measured one, and a fixture that cannot fail would assert
# nothing while looking like cover.
pin() {
	local base="$1" head="$2" path="$3" out
	out="$(git diff --diff-algorithm=histogram --numstat "$base" "$head" -- "$path" | cut -f1,2 | tr '\t' ' ')"
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

	if [ "$add_before" -eq "$add_after" ] && [ "$del_before" -eq "$del_after" ]; then
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
		if [ "$del_after" -lt "$del_before" ]; then
			printf '  deletions went DOWN: %s line(s) this branch REMOVED are back.\n' \
				"$((del_before - del_after))"
			printf '  This is #1432 in the mirror direction, and it is the one a\n'
			printf '  deletions-must-be-zero rule could not express: union takes the\n'
			printf '  additions from both sides and NEVER the deletions, so a branch\n'
			printf '  whose work IS a removal is exactly what it undoes — rc=0, no\n'
			printf '  conflict, nothing deleted, all three signals agreeing.\n'
		elif [ "$del_after" -gt "$del_before" ]; then
			printf '  deletions went UP: the rebase now removes %s line(s) this branch\n' \
				"$((del_after - del_before))"
			printf '  never touched.\n'
		fi
		if [ "$add_after" -eq 0 ] && [ "$del_after" -eq 0 ]; then
			printf '  The contribution is EMPTY against the new base: nothing this branch\n'
			printf '  did to that path survives. Two zeroes are not a small drift.\n'
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
