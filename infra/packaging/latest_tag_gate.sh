#!/bin/sh
# latest_tag_gate.sh — answer whether a release TAG may take the MUTABLE ghcr
# `:latest` pointer, so the answer is DERIVED rather than sorted for.
#
#   latest_tag_gate.sh v1.3.1      -> yes   (the highest release tag)
#   latest_tag_gate.sh v1.3.0-rc2  -> no    (a pre-release, whatever it outranks)
#   latest_tag_gate.sh v0.7.5      -> no    (a backport, below v0.8.0)
#   latest_tag_gate.sh v1.3        -> refused, exit 2
#
# The VERDICT goes to stdout as a bare `yes`/`no`, the REASON to stderr. The
# caller consumes the first and logs the second — the same split
# `prerelease_flag.sh` uses for its token and its refusals.
#
# WHY THIS EXISTS (GH #1686). The gate this replaces ranked with
#
#     highest="$(git tag -l 'v*' --sort=-v:refname | head -1)"
#
# and `versionsort.suffix` is not configured in this repository, so git's
# version sort puts a `-rcN` suffix ABOVE the bare version. The defect has TWO
# faces and the issue reports one. Both are quoted from the runs' own logs,
# not derived:
#
#     2026-08-20T23:38:15Z  v1.3.0-rc2 is the highest tag — tagging :latest
#     2026-08-21T19:18:58Z  v1.3.0 is NOT the highest (v1.3.0-rc2) — NOT tagging :latest
#     2026-08-22T08:40:28Z  v1.3.1 is the highest tag — tagging :latest
#
# Face one: a CANDIDATE took `:latest`. Face two: the STABLE release that
# followed was then DENIED it by its own candidate, so `:latest` skipped
# v1.3.0 entirely and served rc2 until v1.3.1 — ~33h, not the ~20h the issue
# bounds it at. `:latest` is what an operator following the published docker
# path pulls (`compose.release.yaml`, `infra/docker/deploy.sh update`).
#
# WHY NOT `versionsort.suffix`, which the issue also proposes — falsified by
# measurement, not by taste. On a scratch repository holding the tag set as it
# stood at the rc2 push (v1.0.0 v1.1.0 v1.2.0 v1.3.0-rc1 v1.3.0-rc2, no
# v1.3.0 yet):
#
#     git tag -l 'v*' --sort=-v:refname                 -> v1.3.0-rc2
#     git -c versionsort.suffix=- tag -l ... --sort=...  -> v1.3.0-rc2
#
# Identical. The suffix orders a candidate against ITS OWN release and nothing
# else, so it repairs face two and leaves the MEASURED face one exactly where
# it was. Restricting the ranking to releases repairs both — and once
# pre-releases are out of the candidate set the suffix has nothing left to
# order, so configuring it as well would be a second mechanism doing the
# first one's job. One mechanism, one owner: the drift #1591 / #1594 / #1636
# all were is what two of them become.
#
# THE CLASSIFIER IS NOT WRITTEN TWICE. "Does semver call this a pre-release"
# already has an answer in this directory — `prerelease_flag.sh` (#1636),
# measured against `Version.parse/1` on the pinned toolchain, and it already
# REFUSES with exit 2 what it cannot classify. A hand-rolled second comparison
# here (`grep -v -- -`, say) would be wrong on the row that decided that
# script's implementation: `v1.4.0+foo-bar` carries a hyphen INSIDE its build
# metadata and is a release.
#
# A TAG THIS CANNOT CLASSIFY IS SKIPPED, NOT FATAL — for tags found in the
# REPOSITORY. A stray `nightly-2026-08-01` must not become a permanent veto
# over every future release, and skipping is the conservative direction: a tag
# the classifier refuses never had images published under it, so it cannot be
# the release `:latest` should point at. The tag UNDER TEST is the opposite
# case and is refused outright (exit 2) — the permissive answer there is the
# one that publishes.
#
# Caller: the `docker` job of `.github/workflows/release.yml`, for BOTH
# images — `grappa` and the `grappa-shottino` bridge are cut from the same tag
# and share one `emit_tags` (#1168), so this verdict reaches both. Gate:
# `test/infra/release_latest_gate_test.bats`.
#
# POSIX sh, like its siblings `version.sh` / `pkgversion.sh` /
# `prerelease_flag.sh` — the derived dash-parse gate (scripts/posix-parse.sh)
# keys on line 1.
#
# Why: docs/OPERATIONS.md § "Packaging (infra/packaging/)".
set -eu

die() {
	printf 'latest_tag_gate.sh: %s\n' "$1" >&2
	exit 2
}

classify="$(dirname "$0")/prerelease_flag.sh"

tag="${1:-}"

[ -n "${tag}" ] || die 'no tag given (usage: latest_tag_gate.sh vX.Y.Z)'

# The floor. Without it a missing classifier degrades into "no tag is ever a
# pre-release", which answers `yes` for a candidate — the exact publication
# this gate exists to stop. On a #573 (b) image repair the checked-out tree is
# the OLD TAG's, and every tag before v1.3.0 predates `prerelease_flag.sh`;
# release.yml takes both scripts from the dispatched ref for that reason, and
# this line is what makes a mistake there loud instead of permissive.
[ -x "${classify}" ] || die "classifier ${classify} is missing — refusing to decide :latest without it"

if ! flag="$("${classify}" "${tag}")"; then
	die "cannot classify ${tag} — refusing to decide :latest for a tag nobody can read"
fi

# A pre-release is ineligible whatever it outranks, so this arm answers before
# any ranking happens. It is a SEPARATE arm rather than a fall-through of the
# scan below for log honesty: `v1.3.0-rc2 is NOT the highest (v1.2.0)` is what
# the fall-through would print, and it is false — rc2 IS higher than v1.2.0.
# A fast path states what it observed.
if [ "${flag}" = '--prerelease=true' ]; then
	printf '%s is a pre-release — NOT tagging :latest\n' "${tag}" >&2
	printf 'no\n'
	exit 0
fi

# The highest RELEASE tag: walk git's version order from the top and stop at
# the first tag the classifier calls a release. Pre-releases above it are
# named as they are passed over — they are the evidence for the verdict, and
# the loop stops at the winner so the list cannot run long.
#
# Word splitting is what iterates here, and it is safe: `git check-ref-format`
# forbids whitespace in a refname, so no tag can split into two.
highest=''
for candidate in $(git tag -l 'v*' --sort=-v:refname); do
	if candidate_flag="$("${classify}" "${candidate}" 2>/dev/null)"; then
		if [ "${candidate_flag}" = '--prerelease=false' ]; then
			highest="${candidate}"
			break
		fi
		printf 'ranking skips %s — a pre-release is not a candidate for :latest\n' "${candidate}" >&2
	else
		printf 'ranking skips %s — the classifier refuses it, so no release was ever published under it\n' "${candidate}" >&2
	fi
done

if [ "${tag}" = "${highest}" ]; then
	printf '%s is the highest release tag — tagging :latest\n' "${tag}" >&2
	printf 'yes\n'
else
	printf '%s is NOT the highest release tag (%s) — NOT tagging :latest\n' "${tag}" "${highest:-none}" >&2
	printf 'no\n'
fi
