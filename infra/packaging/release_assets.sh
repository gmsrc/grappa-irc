#!/usr/bin/env bash
# release_assets.sh — the single source of truth for grappa's EXPECTED
# release asset set, and the completeness audit derived from it (#573).
#
# The release `publish` job used to inline its "collect what built" find
# glob and had NO notion of what SHOULD have built. So two releases
# (v0.8.0, v0.9.0) shipped without their .rpm — the rpm leg died, publish
# attached whatever downloaded, and the artifact list was
# INDISTINGUISHABLE from a complete one. Red-and-ignored: the run was red
# both times and nobody looked. See #573.
#
# This script closes the hole by deriving BOTH the attach glob (`found`)
# and the audit (`missing`/`notice`/`apply-body`) from ONE expected-kinds
# table, so the two can never drift. It is pure filesystem + string logic
# (no docker, no network, no mix), which is exactly why it can live under
# bats (test/infra/release_assets_test.bats) rather than untested inside
# release.yml — the bug lived in the untested inline YAML.
#
# Subcommands (the bats suite pins the contract — fit the script to it):
#   found <dir>       every file under <dir> matching an expected kind BY
#                     NAME at ANY depth, sorted, one per line. Name-, not
#                     path-matched: download-artifact has unpacked the tree
#                     flat before (run 30399152630), which a path-coupled
#                     glob missed.
#   missing <dir>     the human LABEL of each expected kind with no matching
#                     file, one per line. Empty output = complete set.
#   notice <dir>      nothing if complete; else a sentinel-delimited markdown
#                     block naming the gap.
#   apply-body <dir>  read a release body from STDIN, strip any existing
#                     sentinel block, and — only if the set is incomplete —
#                     PREPEND a fresh one. Print the result. Idempotent (run
#                     twice = one block); the converse holds too, a
#                     now-complete set REMOVES a stale block (the #573 (b)
#                     repair reconciles the body back to clean).
#   anything else     usage error (non-zero exit).
#
# Follows the sibling packaging scripts' shape (build.sh / version.sh):
# bash, `set -euo pipefail`, self-locating, loud on misuse.
set -euo pipefail

# The EXPECTED release asset kinds: one `find -name` pattern + its human
# label per line, TAB-separated. This table IS the contract — the attach
# glob and the audit both read it, so a new package kind is added in ONE
# place and both halves follow. Keep it byte-aligned with the bats suite.
expected_kinds() {
	printf '%s\n' \
		'*.deb	Debian package (.deb)' \
		'*.rpm	RPM package (.rpm)' \
		'*.pkg.tar.zst	Arch package (.pkg.tar.zst)' \
		'PKGBUILD	Arch PKGBUILD recipe' \
		'.SRCINFO	Arch .SRCINFO recipe'
}

# Sentinel markers delimiting the partial-release block inside a release
# body. `apply-body` keys strip/replace off these, never off the block
# TEXT, so the block wording can change without breaking idempotency.
SENTINEL_START='<!-- grappa:partial-release:start -->'
SENTINEL_END='<!-- grappa:partial-release:end -->'

# found <dir> — every expected-kind file under <dir>, by name at any depth,
# sorted. The publish job's attach list.
found() {
	local dir="$1" pat label
	while IFS=$'\t' read -r pat label; do
		find "$dir" -type f -name "$pat"
	done < <(expected_kinds) | sort
}

# missing <dir> — the label of every expected kind with no matching file.
# Empty stdout means the set is complete.
missing() {
	local dir="$1" pat label
	while IFS=$'\t' read -r pat label; do
		if [ -z "$(find "$dir" -type f -name "$pat")" ]; then
			printf '%s\n' "$label"
		fi
	done < <(expected_kinds)
}

# is_complete <dir> — true when nothing is missing.
is_complete() {
	[ -z "$(missing "$1")" ]
}

# notice_block <dir> — the sentinel-delimited markdown block naming the
# gap. Caller must only invoke it on an incomplete set.
notice_block() {
	local dir="$1" label
	printf '%s\n' "$SENTINEL_START"
	printf '> [!WARNING]\n'
	printf '> **Partial release** — the following expected package(s) failed to build and are NOT attached to this release:\n'
	while IFS= read -r label; do
		printf '> - %s\n' "$label"
	done < <(missing "$dir")
	printf '%s\n' "$SENTINEL_END"
}

# notice <dir> — the block if incomplete, nothing if complete.
notice() {
	local dir="$1"
	if is_complete "$dir"; then
		return 0
	fi
	notice_block "$dir"
}

# strip_block — remove every existing sentinel block (inclusive) from stdin.
strip_block() {
	awk -v s="$SENTINEL_START" -v e="$SENTINEL_END" '
		index($0, s) { skip = 1 }
		skip && index($0, e) { skip = 0; next }
		!skip { print }
	'
}

# apply-body <dir> — reconcile the STDIN release body with the current
# asset set: strip any stale block, prepend a fresh one iff incomplete.
apply_body() {
	local dir="$1" body stripped
	body="$(cat)"
	# Strip the old block, then drop the leading blank lines it left behind
	# so a re-run doesn't accrete whitespace above the changelog.
	stripped="$(printf '%s\n' "$body" | strip_block | sed '/./,$!d')"
	if is_complete "$dir"; then
		printf '%s\n' "$stripped"
	else
		notice_block "$dir"
		printf '\n'
		printf '%s\n' "$stripped"
	fi
}

main() {
	local cmd="${1:-}"
	case "$cmd" in
		found | missing | notice)
			[ "$#" -eq 2 ] || die_usage
			"$cmd" "$2"
			;;
		apply-body)
			[ "$#" -eq 2 ] || die_usage
			apply_body "$2"
			;;
		*)
			die_usage
			;;
	esac
}

die_usage() {
	printf 'usage: %s {found|missing|notice|apply-body} <assets-dir>\n' "${0##*/}" >&2
	exit 2
}

main "$@"
