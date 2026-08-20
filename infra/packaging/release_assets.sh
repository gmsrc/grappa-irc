#!/usr/bin/env bash
# release_assets.sh — the single source of truth for grappa's EXPECTED
# release asset set, and the completeness audit derived from it. The
# release `publish` job reads both from here, so they cannot drift.
#
# Subcommands (contract pinned by test/infra/release_assets_test.bats —
# fit the script to it):
#   found <dir>       every file under <dir> matching an expected kind BY
#                     NAME at ANY depth, sorted, one per line. Name-, not
#                     path-matched: download-artifact sometimes unpacks the
#                     tree flat.
#   missing <dir>     the human LABEL of each expected kind with no matching
#                     file, one per line. Empty output = complete set.
#   notice <dir>      nothing if complete; else a sentinel-delimited markdown
#                     block naming the gap.
#   publishable <dir> <absent|present>
#                     exit 0 when publishing may proceed. Refuses (exit 1,
#                     reason on stdout) for an INCOMPLETE set against a
#                     release that does not exist yet — see below.
#   apply-body <dir>  read a release body from STDIN, strip any existing
#                     sentinel block, and — only if the set is incomplete —
#                     PREPEND a fresh one. Print the result. Idempotent both
#                     ways: run twice = one block, and a now-complete set
#                     REMOVES a stale block.
#   anything else     usage error (non-zero exit).
#
# Why: docs/OPERATIONS.md § "Packaging (infra/packaging/)" (#573).
set -euo pipefail

# The EXPECTED release asset kinds: one `find -name` pattern + its human
# label per line, TAB-separated. This table IS the contract — a new package
# kind is added HERE and both the attach glob and the audit follow. Keep it
# byte-aligned with the bats suite.
#
# Patterns are scoped by PACKAGE NAME, not by extension alone (#1447 slice B).
# Since the terminal client ships as its own artifact, every format produces
# TWO packages, and a bare `*.deb` is satisfied by either of them: a release
# whose client leg died would match on the bouncer's file, report a complete
# set, and publish without the client SILENTLY. That is #573's failure one
# package later, and the same posture the packaging README states one level
# down — a package that silently ships without a binary it advertises is worse
# than one that refuses to build.
#
# The names come from the builders, not from taste: nfpm writes
# `<name>_<ver>_<arch>.deb` and `<name>-<ver>-1.<arch>.rpm`, makepkg writes
# `<name>-<ver>-1-<arch>.pkg.tar.zst`.
expected_kinds() {
	printf '%s\n' \
		'grappa_*.deb	Debian package, bouncer (.deb)' \
		'shottino_*.deb	Debian package, client (.deb)' \
		'grappa-*.rpm	RPM package, bouncer (.rpm)' \
		'shottino-*.rpm	RPM package, client (.rpm)' \
		'grappa-*.pkg.tar.zst	Arch package, bouncer (.pkg.tar.zst)' \
		'shottino-*.pkg.tar.zst	Arch package, client (.pkg.tar.zst)' \
		'PKGBUILD	Arch PKGBUILD recipe, bouncer' \
		'.SRCINFO	Arch .SRCINFO recipe, bouncer' \
		'shottino.PKGBUILD	Arch PKGBUILD recipe, client' \
		'shottino.SRCINFO	Arch .SRCINFO recipe, client'
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

# publishable <dir> <absent|present> — may the publish job proceed?
#
# #1591. `publish` runs under `if: !cancelled()`, so a red package leg still
# reached `gh release create` and PUBLISHED — partial, marked as such, and
# public. #504/#573 chose that deliberately: a distro breakage must not
# withhold the artifacts that built green, and the failed leg stays red on its
# own. That reasoning is sound for a release that ALREADY EXISTS, where
# attaching what built is the only way to complete it, and it is what the
# `#573 (b)` repair dispatch is for.
#
# It does not survive the FIRST run of a fresh tag. There the same rule turns
# "one leg failed" into a public artefact, and publication is not an act CI
# can take back: deleting the tag afterwards does not retract the release.
# Cutting `v1.3.0-rc1` did exactly this — `assets=0` on a public release
# object — which is why the axis is completeness × does-the-release-exist,
# not completeness alone.
#
# The state is an ARGUMENT rather than a probe done here: this script is pure
# filesystem + string logic with no network and no `gh`, and the caller
# already holds a token. Unknown states are refused rather than defaulted,
# because the permissive default is the one that publishes.
publishable() {
	local dir="$1" state="$2"

	case "$state" in
		absent | present) ;;
		*)
			printf 'unknown release state %s (want: absent | present)\n' "${state:-<empty>}" >&2
			return 2
			;;
	esac

	if is_complete "$dir"; then
		return 0
	fi

	# Incomplete against an existing release: top it up (#504/#573).
	if [ "$state" = present ]; then
		printf 'release already exists — attaching what built, and marking it partial (#504/#573)\n'
		return 0
	fi

	# Incomplete against no release: refuse. Name the gap — the operator's
	# next move is to fix that leg and re-run, and a bare refusal makes them
	# go find out which one.
	printf 'refusing to CREATE a release from an incomplete set — publication cannot be retracted (#1591).\n'
	printf 'missing:\n'
	missing "$dir" | while IFS= read -r label; do printf -- '- %s\n' "$label"; done
	return 1
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
		publishable)
			[ "$#" -eq 3 ] || die_usage
			publishable "$2" "$3"
			;;
		*)
			die_usage
			;;
	esac
}

die_usage() {
	printf 'usage: %s {found|missing|notice|apply-body} <assets-dir>\n' "${0##*/}" >&2
	printf '       %s publishable <assets-dir> {absent|present}\n' "${0##*/}" >&2
	exit 2
}

main "$@"
