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
# This gate is that ritual, automated. The SHAPE checks are DIFF-SCOPED on
# purpose (check 0, the rollover, is not — see below): they judge
# only the entry headings the branch ADDS relative to its merge base, so they
# carry no opinion about the 426 historical headings that predate the
# convention (measured on efa69e35: 645 level-2 headings, 219 in the canonical
# shape). A file-wide rule would have had to either rewrite the shape of old
# entries or carry an exemption list, and would still have been WRONG in kind —
# 12 of those headings are not entry headings at all (7 document sections, and
# 5 mis-levelled subsections inside the 2026-08-08 #1038 entry).
#
# THE CHECKS, and why each
#
#   0. no CLOSED month is still inline (issue 2138) — the one check that is
#      FILE-scoped rather than diff-scoped, and the reason is the finding it
#      comes from. `docs/DESIGN_NOTES.md` is the current month plus the undated
#      preamble; closed months are archived verbatim in
#      `docs/design_notes/YYYY-MM.md` (#1537). Nothing enforced that, so the
#      rollover simply stopped after July: 495 August entries were still inline
#      six weeks later, in a file of 3.3 MB. A stale month is a property of the
#      FILE — the branch that must fix it is whichever one is next, not the one
#      that wrote the entries — so this check ignores the diff entirely, and
#      runs even on a branch that appends nothing (most PRs never touch the
#      log; gated behind the diff the enforcement would be dead exactly where
#      the debt lives).
#
#      "CLOSED" is read off the FILE and never off the clock: the newest month
#      with an inline entry is the current one, every older month is closed. A
#      wall-clock rule would turn main red at midnight on the 1st for work
#      nobody did, and could not be tested without a time seam. This one goes
#      red on the branch that opens a new month — attributable, and the moment
#      the rollover actually falls due.
#
#      It reads the DATE in the heading because that is the only month signal
#      the file carries; append order is not recoverable from it. That is a
#      membership rule and NOT an answer to whether the log is ordered by date
#      or by append order — an entry dated 2026-08-31 and appended in September
#      belongs to August either way.
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
#   3. uniqueness has TWO scopes, and check 2's file-wide count only closes one
#      of them (#1428). Two copies in one file it can see. A copy the BASE
#      already carries it cannot: the branch's own file holds the marker
#      exactly ONCE, nothing local is duplicated, and the collision only
#      becomes real at the rebase — which is also when it stops being
#      detectable, because the collapse leaves a single marker behind to count.
#      So the added markers are compared against the base as well. Measured on
#      the scratch repo the bats suite builds: that rebase reports rc=0, zero
#      deletions, and takes FOUR lines — one MORE than carrying no marker at
#      all, because the duplicated marker collapses together with the separator
#      block it was added to protect.
#   4. the marker is the FIRST appended line, with nothing above it — not even
#      a blank. Check 2 cannot see this and never could: it reads the four
#      lines above the heading, the marker is the fourth of them, so a stray
#      blank sits at the fifth and those four still spell the canonical shape.
#      Green, measured (issue 2011). A blank is the most collidable first line
#      there is — every entry in the legacy shape opens with one — so a
#      blank-led marker hands the driver back exactly the identical prefix the
#      marker exists to destroy. Against a legacy entry the branch then loses
#      one line, rc=0, zero deletions; and the line lost IS that blank, so the
#      entry reads canonical afterwards with nothing left to find. That is why
#      this is a coverage gap cured by a fifth line of history, and why the
#      only window for it is BEFORE the rebase.
#
# THE REFERENCE FOR CHECK 3 IS THE BASE REF'S TIP, NOT THE MERGE BASE. This is
# the whole finding and it is easy to undo by tidying: the colliding entry
# landed on main AFTER the branch was cut — that is what "a rebase is when a
# previously-unique marker stops being unique" means. At the merge base the
# marker is not there yet, so a check written against `$base` measures nothing
# and passes every real occurrence. Checks 1 and 2 stay diff-scoped against the
# merge base, because they judge the SHAPE of what the branch wrote; check 3
# judges a COLLISION with what the branch is about to land on.
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
# Exit 0 = no closed month is inline, and every added entry is well formed (or
#          the branch adds none).
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

status=0

# ── Check 0: the rollover ────────────────────────────────────────────────────
#
# Every dated entry heading in the file, as `month<TAB>line<TAB>heading`. Read
# off the KEY line and nothing else: the rollover's own index table carries a
# `| 2026-08 | ... |` row forever after, the preamble names the boundary month
# in prose, and entries quote entry headings inside fences — a matcher that
# reads any of those is green on a broken file and red on a correct one, which
# is the shape of an assertion that passes on the documentation of its own
# subject. Fences are skipped for the same reason check 1 skips them.
inline_entries="$(awk '
/^(```|~~~)/ { fence = !fence; next }
!fence && /^## [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]/ {
    printf "%s\t%d\t%s\n", substr($0, 4, 7), FNR, $0
}
' "$FILE")"

if [ -z "$inline_entries" ]; then
	rollover_summary="$FILE carries no dated entry inline."
else
	newest="$(printf '%s\n' "$inline_entries" | cut -f1 | sort -u | tail -1)"
	current_count="$(printf '%s\n' "$inline_entries" | cut -f1 | grep -Fxc "$newest")"
	stale="$(printf '%s\n' "$inline_entries" | awk -F'\t' -v cur="$newest" '$1 != cur')"
	rollover_summary="$FILE carries one month inline ($newest, $current_count entries) — nothing to roll over."
fi

if [ -n "${stale:-}" ]; then
	status=1
	{
		printf 'design-notes-gate: closed month(s) still inline in %s — the current month is %s:\n' \
			"$FILE" "$newest"
		printf '%s\n' "$stale" | awk -F'\t' '
			{ n[$1]++; if (!($1 in first)) { first[$1] = $2; head[$1] = $3 } }
			END {
			    for (m in n)
			        printf "  %s\t%d entr%s\tfirst at line %d: %s\n",
			            m, n[m], (n[m] == 1 ? "y" : "ies"), first[m], head[m]
			}
		' | sort
		printf '\nThis log is the CURRENT month plus the undated preamble; a closed\n'
		printf 'month is archived VERBATIM in docs/design_notes/YYYY-MM.md and listed\n'
		printf 'in the preamble index (#1537). Nothing enforced that before issue\n'
		printf '2138, which is how the rollover stopped after July and left 495\n'
		printf 'August entries inline for six weeks.\n\n'
		printf 'Moving them is a mass DELETION from a merge=union path, where the\n'
		printf 'failure mode is RESURRECTION and not loss: union takes the additions\n'
		printf 'from both sides and never the deletions, so any branch forked before\n'
		printf 'the move brings the text back with rc=0, no conflict and no deleted\n'
		printf 'line. Predict the byte and line arithmetic on BOTH files before\n'
		printf 'moving anything, and rebase through scripts/union-rebase.sh.\n'
	} >&2
fi

# ── The shape checks, diff-scoped ────────────────────────────────────────────
#
# The entry headings this branch adds. `+## ` cannot collide with diff's own
# `+++ ` header line.
#
# 🔴 The diff algorithm is PINNED here and at the marker check below. What
# counts as an ADDED line is the aligner's opinion, not a fact about the
# branch, and the default (`myers`, heuristics on) will attribute to a branch
# lines it never touched once that branch deletes in bulk from a large file.
#
# Measured, issue 2138, the August rollover rebased onto 702834fd7 — 44,287
# lines out of 57,421. myers reported
#
#     +## Open design questions
#     +## What's *not* in this document (on purpose)
#
# as ADDITIONS. Both are PREAMBLE headings, byte-identical on the base and on
# the merge base (lines 366/378 there, 369/381 here). The gate then demanded
# an entry marker on two lines nobody wrote — rc=1 on a rebase that was
# byte-for-byte correct. With histogram only the one heading the branch
# really adds is reported.
#
# This is not incidental to the rollover: check 0 above makes a bulk-deletion
# branch MANDATORY every month, so that shape is the gate's routine input
# now, not a rarity. Untested — two fixtures failed to reproduce the
# aligner's instability; see the note on pin() in scripts/union-rebase.sh.
added="$(git diff --diff-algorithm=histogram "$base" HEAD -- "$FILE" | sed -n 's/^+\(## .*\)$/\1/p')"

if [ -z "$added" ]; then
	printf 'design-notes-gate: this branch adds no %s entry heading — the shape checks have nothing to judge.\n' "$FILE"
	# Only when check 0 found nothing: a summary reading "nothing to roll
	# over" under a finding that says the opposite is the log-honesty bug in
	# its purest form, and this fast path is the one place it can print.
	if [ "$status" -eq 0 ]; then
		printf 'design-notes-gate: %s\n' "$rollover_summary"
	fi
	exit "$status"
fi

# Locate each added heading in the resulting file and read the four lines above
# it. Fenced blocks are skipped: a `## ` inside one is shell or markdown sample
# text, not an entry.
findings="$(awk '
NR == FNR { want[$0] = 1; next }
/^(```|~~~)/ { fence = !fence; p5 = p4; p4 = p3; p3 = p2; p2 = p1; p1 = $0; next }
!fence && /^## / && ($0 in want) {
    if (!(p1 == "" && p2 == "---"))
        printf "%d\tSEPARATOR\t%s\n", FNR, $0
    else if (p3 != "" || p4 !~ /^<!-- entry .+ -->$/)
        printf "%d\tMARKER\t%s\n", FNR, $0
    else if (FNR > 5 && p5 == "")
        printf "%d\tBLANK\t%s\n", FNR, $0
}
{ p5 = p4; p4 = p3; p3 = p2; p2 = p1; p1 = $0 }
' <(printf '%s\n' "$added") "$FILE")"

separator_findings="$(printf '%s\n' "$findings" | grep -F "	SEPARATOR	" || true)"
if [ -n "$separator_findings" ]; then
	status=1
	{
		printf 'design-notes-gate: entry heading(s) NOT preceded by a --- separator:\n'
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
		printf 'design-notes-gate: entry heading(s) with no <!-- entry ... --> marker line:\n'
		printf '%s\n' "$marker_findings"
		printf '\nAn entry must open with a UNIQUE marker line, as the FIRST appended\n'
		printf 'line, in this exact shape:\n\n'
		printf '    <!-- entry #1271 -->\n    <blank>\n    ---\n    <blank>\n    ## 2026-08-13 — #1271: ...\n\n'
		printf 'It is what leaves the merge machinery no identical prefix to collapse.\n'
	} >&2
fi

blank_findings="$(printf '%s\n' "$findings" | grep -F "	BLANK	" || true)"
if [ -n "$blank_findings" ]; then
	status=1
	{
		printf 'design-notes-gate: entry marker(s) with a blank line ahead of them:\n'
		printf '%s\n' "$blank_findings"
		printf '\nThe marker is the FIRST appended line, with nothing before it.\n'
		printf 'A blank ahead of it is the identical prefix all over again — a\n'
		printf 'blank collides with every entry in the legacy separator-first\n'
		printf 'shape, which is most of this file, and with every other blank-led\n'
		printf 'entry. Measured: the driver emits it once and the branch loses a\n'
		printf 'line, rc=0 and zero deletions. The line it eats IS that blank, so\n'
		printf 'the entry then reads canonical and nothing is left to find — which\n'
		printf 'is why this is checked here and cannot be checked after a rebase.\n'
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

# The other scope of the same uniqueness (#1428): a marker the BASE already
# carries. Both sets are matched as WHOLE lines (`-x`): a marker collides only
# with a byte-identical one, since only a byte-identical prefix is what the
# merge machinery collapses. No reachable substring pair is known — `-x` states
# the contract rather than closing a measured hole.
# Same algorithm pin as the heading check above, for the same reason: a
# marker misattributed as ADDED by the aligner would be tested for collision
# against the base that already legitimately carries it, and report the
# branch as colliding with itself.
added_markers="$(git diff --diff-algorithm=histogram "$base" HEAD -- "$FILE" | sed -n 's/^+\(<!-- entry .* -->\)$/\1/p' | sort -u)"
base_markers="$(git show "$BASE_REF:$FILE" 2>/dev/null | grep '^<!-- entry .* -->$' || true)"

collisions=""
if [ -n "$added_markers" ] && [ -n "$base_markers" ]; then
	collisions="$(printf '%s\n' "$added_markers" \
		| grep -Fxf <(printf '%s\n' "$base_markers") || true)"
fi

if [ -n "$collisions" ]; then
	status=1
	{
		printf 'design-notes-gate: entry marker(s) already carried by %s — pick a fresh one:\n' "$BASE_REF"
		printf '%s\n' "$collisions"
		printf '\nA marker defeats merge=union only because it DIFFERS between the two\n'
		printf 'sides. One the base already carries restores the identical prefix the\n'
		printf 'convention exists to destroy, and the rebase then eats FOUR lines with\n'
		printf 'rc=0 and zero deletions — the separator block plus the marker itself,\n'
		printf 'one MORE than carrying no marker at all.\n\n'
		printf 'Rename yours. One issue producing several entries needs distinct\n'
		printf 'suffixes (#1404a, #1404b, ...), chosen against what the base carries\n'
		printf 'NOW rather than when the branch was cut.\n'
	} >&2
fi

if [ "$status" -ne 0 ]; then
	exit 1
fi

printf 'design-notes-gate: %s new entry heading(s), separator and marker present.\n' \
	"$(printf '%s\n' "$added" | wc -l | tr -d ' ')"
printf 'design-notes-gate: %s\n' "$rollover_summary"
