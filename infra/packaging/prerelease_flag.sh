#!/bin/sh
# prerelease_flag.sh — echo the `gh release create` pre-release flag that a
# release TAG calls for, so the marker is DERIVED and never remembered.
#
#   prerelease_flag.sh v1.3.0      -> --prerelease=false
#   prerelease_flag.sh v1.3.0-rc2  -> --prerelease=true
#   prerelease_flag.sh v1.3        -> refused, exit 2
#
# WHY THIS EXISTS (GH #1636). `gh release create` was called with no
# pre-release flag at all, so the pipeline's answer for every tag it ever cut
# was "full release". `v1.3.0-rc1` reads `isPrerelease: true` only because a
# human flipped it after the run; `v1.3.0-rc2` was published `false` and
# flipped by hand as well. GitHub picks "Latest" among the releases that are
# neither draft nor pre-release, so a green candidate run was the only thing
# standing between a release candidate and the repository's landing page —
# `GET /releases/latest` still answered `v1.2.0`, which makes this exposure
# rather than damage.
#
# WHY THE TAG AND NOT THE CARRIER. `version.sh` reads the repo-root `VERSION`
# of the CHECKED-OUT tree, and on the `#573 (b)` repair dispatch that tree is
# the DISPATCHED ref while the release object is keyed by the dispatched
# `tag` input — `release.yml` says so where it checks out (an old tag "predates
# this work entirely"). The tag is what names the release being marked, so the
# tag is what the marker is derived from.
#
# WHY NOT REUSE ONE OF THE TWO MAPPERS NEXT DOOR — falsified by measurement,
# not by taste. `aur/pkgver.sh` and the `pkgversion.sh` deb map are both
# pre-release-aware, so "did the mapping change the string" looks like a free
# oracle. Measured, it is wrong in both directions:
#
#     aur/pkgver.sh 1.3.0-1        rc=2  — it REFUSES a legal semver
#                                          pre-release, correctly for pacman
#                                          (#1591: `1.3.01` would outrank
#                                          `1.3.0`). As an oracle here it
#                                          would kill the publish step instead
#                                          of marking the release.
#     aur/pkgver.sh 1.3.0+foo-bar  -> 1.3.0+foobar   changed, yet `pre: []`
#     sed 's/-/~/'  1.3.0+foo-bar  -> 1.3.0+foo~bar  changed, yet `pre: []`
#
# Both would publish a stable release as a candidate. They answer "what does
# this packager stamp"; the question here is "does semver call this a
# pre-release", and the two only coincide by accident.
#
# THE RULE IS SEMVER'S, MEASURED against `Version.parse/1` on the pinned
# toolchain (the same parser `mix.exs` hands the OTP application vsn to):
#
#     1.3.0          pre: []                        release
#     1.3.0-rc1      pre: ["rc1"]                   pre-release
#     1.3.0-rc.1     pre: ["rc", 1]                 pre-release
#     1.3.0-rc-1     pre: ["rc-1"]                  pre-release
#     1.3.0-1        pre: [1]                       pre-release
#     1.3.0+foo      pre: [],  build: "foo"         release
#     1.3.0+foo-bar  pre: [],  build: "foo-bar"     release
#     1.3.0-rc1+foo  pre: ["rc1"], build: "foo"     pre-release
#
# A NON-EMPTY `pre` is exactly the condition for the flag. The `+foo-bar` row
# is what fixes the ORDER of the two splits below: semver puts build metadata
# AFTER the pre-release, so a `+` reached before any `-` means the hyphen
# belongs to the build and there is no pre-release at all.
#
# THE CORE CHECK IS A SHAPE FLOOR, NOT A SECOND SEMVER PARSER, deliberately.
# It rejects a tag that is not `vN.N.N…` so an unclassifiable one stops the
# publish step; it does NOT reproduce semver's finer refusals (`1.03.0` has a
# leading zero and `Version.parse/1` returns `:error`, while this answers
# `--prerelease=false`). Transcribing the whole grammar here would be the
# second writing of a rule that this repo already has one of, which is the
# drift #1591/#1594/#1636 all are. A number that shape-passes here and fails
# semver cannot reach a tag anyway: `VERSION` feeds `mix.exs` and the OTP
# application vsn, and the release job asserts the tag against it.
#
# IT ALWAYS PRINTS A TOKEN, never nothing. `gh release create` defaults a
# missing `--prerelease` to false, so "no output" and "this is a release"
# would be the same byte string — and a derivation that silently produced
# nothing would look exactly like the bug this closes. Measured on gh 2.93.0:
# `--prerelease=false` parses (`gh release create --prerelease=false` errors
# with "tag required", not "unknown flag").
#
# Caller: the `publish` job of `.github/workflows/release.yml`. Gate:
# `test/infra/packaging_prerelease_marker_test.bats`.
#
# POSIX sh, like its siblings `version.sh` / `pkgversion.sh` / `aur/pkgver.sh`
# — the derived dash-parse gate (scripts/posix-parse.sh) keys on line 1.
#
# Why: docs/OPERATIONS.md § "Packaging (infra/packaging/)".
set -eu

die() {
	printf 'prerelease_flag.sh: %s\n' "$1" >&2
	exit 2
}

tag="${1:-}"

[ -n "${tag}" ] || die 'no tag given (usage: prerelease_flag.sh vX.Y.Z[-pre][+build])'

# The `v` is the TAG's, not the version's — `Version.parse("v1.3.0")` is
# `:error`. release.yml fires on a `v*` push, and the repair dispatch's `tag`
# input is documented as `v0.6.0`, so anything else is a tag nobody can be
# publishing and must not be guessed at.
case "${tag}" in
v?*) version="${tag#v}" ;;
*) die "tag '${tag}' is not spelled vX.Y.Z — refusing to guess whether it names a pre-release" ;;
esac

# Build metadata FIRST (see the measured `1.3.0+foo-bar` row above).
case "${version}" in
*+*)
	[ -n "${version#*+}" ] || die "empty build metadata after the '+' in '${tag}'"
	version="${version%%+*}"
	;;
esac

# What is left is `core[-pre]`. The FIRST hyphen is semver's pre-release
# separator; the pre-release may carry further hyphens of its own.
case "${version}" in
*-*)
	core="${version%%-*}"
	pre="${version#*-}"
	[ -n "${pre}" ] || die "empty pre-release after the '-' in '${tag}'"
	;;
*)
	core="${version}"
	pre=""
	;;
esac

# The shape floor: three dot-separated, non-empty, all-digit fields.
#
# A `case` and not `grep -E '^…$'`, because a case pattern matches the WHOLE
# string while grep matches a LINE: a tag carrying a newline would satisfy the
# anchored expression on its first line and be answered as a release.
core_ok=no
case "${core}" in
*[!0-9.]* | .* | *. | *..* | *.*.*.*) ;;
*.*.*) core_ok=yes ;;
esac
[ "${core_ok}" = yes ] ||
	die "tag '${tag}' has no X.Y.Z release core — refusing to guess whether it names a pre-release"

if [ -n "${pre}" ]; then
	printf '%s\n' '--prerelease=true'
else
	printf '%s\n' '--prerelease=false'
fi
