#!/bin/sh
# pkgver.sh — map a canonical `VERSION` onto a `pkgver` makepkg accepts.
#
#   pkgver.sh 1.3.0        -> 1.3.0        (unchanged — every release so far)
#   pkgver.sh 1.3.0-rc1    -> 1.3.0rc1
#   pkgver.sh 1.3.0-1      -> refused, exit 2
#
# WHY THIS EXISTS AT ALL (#1591). `makepkg` refuses a hyphen in `pkgver` —
# measured rc=12, "pkgver is not allowed to contain colons, forward slashes,
# hyphens or whitespace", from its own lint (`[[ $ver = *[[:space:]/:-]* ]]`,
# /usr/share/makepkg/lint_pkgbuild/pkgver.sh). A semver pre-release spells its
# suffix with exactly that character, so cutting `v1.3.0-rc1` killed the Arch
# leg of the release. The repo-root `VERSION` cannot dodge it: it feeds
# `mix.exs` and the OTP application vsn, and the alternatives measured
# `:error` from `Version.parse/1` (`1.3.0rc1`, `1.3.0_rc1`) or, for
# `1.3.0+rc1`, compared `:eq` with `1.3.0` — build metadata takes no part in
# semver precedence, so it would order as the final release. The number stays
# semver; the transformation happens HERE, at the boundary where makepkg's
# constraint actually lives.
#
# WHY THE SPELLING IS "DELETE THE HYPHEN, JOIN NOTHING". Because it is the
# only one that also ORDERS right. `vercmp <candidate> 1.3.0`, pacman 7.1.0,
# every candidate building fine (rc=0):
#
#     1.3.0rc1   -1   the pre-release is OLDER than its release  ← correct
#     1.3.0_rc1  +1   NEWER — the Arch-conventional underscore inverts it
#     1.3.0.rc1  +1
#     1.3.0+rc1  +1
#     1.3.0~rc1  +1
#
# pacman's own comparator says why. Its segment loop is
# `while (*one && *two) { skip separators; ... }`, so when the shorter side
# runs out the loop exits AT THE CONDITION and the leftover separator is never
# skipped; the tie-break that follows is `isalpha(*one) ? -1 : 1`
# (lib/libalpm/version.c — "we never want a remaining alpha string to beat an
# empty string"). A LETTER left over means older. A separator left over means
# newer. So the hyphen is deleted rather than replaced.
#
# WHY IT FAILS CLOSED. That same tie-break is why a numeric-leading
# pre-release cannot be mapped at all: `1.3.0-1` is legal semver that sorts
# below `1.3.0`, but `1.3.01` leaves a DIGIT at the tie-break and measures +1
# — a pre-release package that outranks the release it precedes, so pacman
# would never offer the upgrade. No spelling saves it, so this refuses to
# derive a number rather than publish a wrong one. That refusal is the whole
# reason this is a script and not a `sed`.
#
# NOT INJECTIVE, deliberately: a pre-release with an internal hyphen
# (`1.3.0-rc-1`, legal semver) maps onto the same `pkgver` as `1.3.0-rc1`.
# Two pre-releases of one release colliding is a naming annoyance; the
# ordering property above is what actually breaks a user's upgrade path, and
# it is preserved. Not worth machinery.
#
# Callers: `regen.sh` (both recipes) and the `arch` job of
# `.github/workflows/release.yml` (which asserts the derived number reached
# the built package, and re-checks the ordering with the real `vercmp`).
# Takes the version as an ARGUMENT rather than reading a carrier: composing
# with `version.sh` keeps "which file holds which number" answered in exactly
# one place.
#
# POSIX sh, like its sibling `version.sh` — no bashisms, so the derived
# dash-parse gate (scripts/posix-parse.sh) covers it.
#
# Why: docs/OPERATIONS.md § "Packaging (infra/packaging/)".
set -eu

die() {
	printf 'pkgver.sh: %s\n' "$1" >&2
	exit 2
}

version="${1:-}"

[ -n "${version}" ] || die 'no version given (usage: pkgver.sh <X.Y.Z[-pre]>)'

# Split on the FIRST hyphen: semver's pre-release separator. Everything before
# it is the release core, everything after is the pre-release (which may carry
# further hyphens of its own, and possibly `+build` metadata).
case "${version}" in
*-*)
	core="${version%%-*}"
	pre="${version#*-}"
	;;
*)
	# No pre-release: byte-for-byte pass-through. Every tag cut so far takes
	# this path, so the mapping cannot restamp a normal release.
	printf '%s\n' "${version}"
	exit 0
	;;
esac

[ -n "${core}" ] || die "no release core before the '-' in '${version}'"
[ -n "${pre}" ] || die "empty pre-release after the '-' in '${version}'"

# THE ordering guard, stated as the shape pacman's tie-break reads: what is
# left once the release's segments run out must be a LETTER. A digit there
# makes the pre-release sort NEWER than the release it precedes.
case "${pre}" in
[A-Za-z]*) ;;
*) die "pre-release '${pre}' does not start with a letter — mapping '${version}' would sort NEWER than ${core}, inverting the upgrade path (see the header)" ;;
esac

# Delete every hyphen; join nothing in its place.
pkgver="${core}$(printf '%s' "${pre}" | tr -d '\055')"

# makepkg's own refused class, transcribed from its lint. Nothing above can
# introduce these — VERSION cannot hold them — but a derived value that
# reaches `makepkg` unchecked is how #1591 happened in the first place.
case "${pkgver}" in
*[[:space:]/:-]*) die "derived pkgver '${pkgver}' still carries a character makepkg refuses" ;;
esac

printf '%s\n' "${pkgver}"
