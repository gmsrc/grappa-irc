#!/usr/bin/env bash
# scripts/design-notes-gate.sh — the DESIGN_NOTES entry-boundary gate (#1271).
#
# Usage:
#   scripts/design-notes-gate.sh            # check against origin/main
#   scripts/design-notes-gate.sh <base-ref> # check against another base
#
# WHAT IT GUARDS
#
# `docs/DESIGN_NOTES.md` carries `merge=union` (#114) so that concurrent PRs
# appending entries auto-resolve instead of conflicting by hand. The driver
# does that for the entry BODIES, and silently mangles the boundary between
# them: every entry used to be appended with the same three leading lines
# (blank / `---` / blank), the merge machinery aligns that identical prefix as
# a COMMON addition, and only the diverging tails reach the union driver. Union
# emits the shared prefix once and concatenates both bodies after it. One entry
# keeps its separator, the other loses it — with no conflict, no markers,
# `rc=0` and ZERO deletions, which is why nothing in the tooling ever flagged
# it. Four occurrences on 2026-08-13 alone, each caught only because a human
# pinned `git diff --numstat` before the rebase and compared after.
#
# This gate is that ritual, automated. It is DIFF-SCOPED on purpose: it judges
# only the entry headings the branch ADDS relative to its merge base, so it
# carries no opinion about the 426 historical headings that predate the
# convention (measured on efa69e35: 645 level-2 headings, 219 in the canonical
# shape). A file-wide rule would have had to either rewrite the shape of old
# entries or carry an exemption list, and would still have been WRONG in kind —
# 12 of those headings are not entry headings at all (7 document sections, and
# 5 mis-levelled subsections inside the 2026-08-08 #1038 entry).
#
# THE TWO CHECKS, and why both
#
#   1. every ADDED `## ` heading is preceded by `---` — the detector. It sees
#      whatever the merge machinery does next, including a mechanism nobody has
#      characterised yet.
#   2. every ADDED entry opens with a UNIQUE `<!-- entry ... -->` marker line —
#      the prevention. Measured: because that line differs between the two
#      branches there is no identical prefix left to collapse, and both
#      separators survive. A marker on EITHER side is enough, in both
#      directions, so adoption is incremental. Uniqueness is the mechanism, not
#      decoration: a copy-pasted marker restores the collapsible prefix and the
#      bug with it, silently.
#
# A convention that is only written down depends on somebody remembering it
# across sessions — which is the very property that made this bug survive four
# times in one day. So the convention is asserted, not documented.
#
# CONSEQUENCE worth knowing: an added `^## ` is treated as an ENTRY heading. A
# subsection inside an entry must be `###` or deeper. That is a real constraint
# and a deliberate one — the 2026-08-08 #1038 entry has five `##` subsections
# and they are why a file-wide separator rule cannot exist.
#
# Exit 0 = every added entry is well formed (or the branch adds none).
# Exit 1 = a finding, or the base ref cannot be resolved. A gate that cannot
#          reach its base FAILS; it never passes vacuously.

set -euo pipefail

readonly FILE="docs/DESIGN_NOTES.md"
BASE_REF="${1:-origin/main}"

# The repo we are IN, not the repo this script was copied FROM. The bats suite
# runs this gate inside a scratch repository that reproduces the union loss for
# real; deriving the root from BASH_SOURCE would silently point it back at the
# working checkout and the oracle would measure nothing.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

die() {
	printf 'design-notes-gate: %s\n' "$*" >&2
	exit 1
}

git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null \
	|| die "base ref '$BASE_REF' does not resolve. In CI this means the checkout is shallow — actions/checkout needs fetch-depth: 0."

base="$(git merge-base "$BASE_REF" HEAD)" \
	|| die "no merge base between '$BASE_REF' and HEAD"

# The entry headings this branch adds. `+## ` cannot collide with diff's own
# `+++ ` header line.
added="$(git diff "$base" HEAD -- "$FILE" | sed -n 's/^+\(## .*\)$/\1/p')"

if [ -z "$added" ]; then
	printf 'design-notes-gate: this branch adds no %s entry heading — nothing to check.\n' "$FILE"
	exit 0
fi

# Locate each added heading in the resulting file and read the four lines above
# it. Fenced blocks are skipped: a `## ` inside one is shell or markdown sample
# text, not an entry.
findings="$(awk '
NR == FNR { want[$0] = 1; next }
/^(```|~~~)/ { fence = !fence; p4 = p3; p3 = p2; p2 = p1; p1 = $0; next }
!fence && /^## / && ($0 in want) {
    if (!(p1 == "" && p2 == "---"))
        printf "%d\tSEPARATOR\t%s\n", FNR, $0
    else if (p3 != "" || p4 !~ /^<!-- entry .+ -->$/)
        printf "%d\tMARKER\t%s\n", FNR, $0
}
{ p4 = p3; p3 = p2; p2 = p1; p1 = $0 }
' <(printf '%s\n' "$added") "$FILE")"

status=0

separator_findings="$(printf '%s\n' "$findings" | grep -F "	SEPARATOR	" || true)"
if [ -n "$separator_findings" ]; then
	status=1
	{
		printf 'design-notes-gate: entry heading(s) NOT preceded by `---`:\n'
		printf '%s\n' "$separator_findings"
		printf '\nThis is the #1271 shape. If the rebase reported rc=0 with zero\n'
		printf 'deletions, the union driver ate the separator: restore it IN the\n'
		printf 'commit that carries the entry, never as a separator-only commit\n'
		printf '(that one has the same patch-id as three lines already upstream and\n'
		printf 'gets dropped just as silently).\n'
	} >&2
fi

marker_findings="$(printf '%s\n' "$findings" | grep -F "	MARKER	" || true)"
if [ -n "$marker_findings" ]; then
	status=1
	{
		printf 'design-notes-gate: entry heading(s) with no `<!-- entry ... -->` line:\n'
		printf '%s\n' "$marker_findings"
		printf '\nAn entry must open with a UNIQUE marker line, as the FIRST appended\n'
		printf 'line, in this exact shape:\n\n'
		printf '    <!-- entry #1271 -->\n    <blank>\n    ---\n    <blank>\n    ## 2026-08-13 — #1271: ...\n\n'
		printf 'It is what leaves the merge machinery no identical prefix to collapse.\n'
	} >&2
fi

# Uniqueness is the mechanism. Two entries carrying the same marker restore the
# collapsible prefix, and the gate above would still be green.
duplicates="$(grep -n '^<!-- entry .* -->$' "$FILE" | sed 's/^[0-9]*://' | sort | uniq -d || true)"
if [ -n "$duplicates" ]; then
	status=1
	{
		printf 'design-notes-gate: duplicate entry marker(s) — each must be unique:\n'
		printf '%s\n' "$duplicates"
	} >&2
fi

if [ "$status" -ne 0 ]; then
	exit 1
fi

printf 'design-notes-gate: %s new entry heading(s), separator and marker present.\n' \
	"$(printf '%s\n' "$added" | wc -l | tr -d ' ')"
