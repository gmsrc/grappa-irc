#!/usr/bin/env bash
# regen.sh — turn the committed sentinel recipe into a concrete, buildable
# and publishable one, deriving the version from the repo-root VERSION file.
#
# TWO recipes since #1447, because they carry TWO version lines:
#
#   ./PKGBUILD           the bouncer      pkgver=@GRAPPA_VERSION@
#                                         _grappaver=@GRAPPA_VERSION@
#   ./shottino/PKGBUILD  the client       pkgver=@SHOTTINO_VERSION@
#                                         _grappaver=@GRAPPA_VERSION@
#
# Both sentinels read `@GRAPPA_VERSION@` in the bouncer's recipe and are still
# TWO carriers: since #1591 `pkgver` is the version MAPPED for makepkg and
# `_grappaver` is the raw tag, and a pre-release makes them differ.
#
# A split package could not express that: PKGBUILD(5) does not let a
# `package_*()` override `pkgver`, so both halves would take the bouncer's
# number and `shottino --version` would disagree with the package it came
# from. The client's SOURCE is still the grappa tag tarball, which is why its
# recipe also carries `_grappaver` — the tag that exists on GitHub.
#
# This is the ONE path that fills those sentinels, shared by:
#
#   * .github/workflows/release.yml's Arch job (before `makepkg -sf`), and
#   * the human AUR publish (see README.md "Publishing to the AUR").
#
# Steps, per recipe: derive the version from its own carrier, refresh the
# checksums against the tag tarball (updpkgsums), regenerate .SRCINFO. Run from
# a checkout on the release tag — updpkgsums fetches the `vX.Y.Z` tarball, so
# the tag must already exist.
#
# NB: this rewrites both PKGBUILDs in place. The RESULT is what you
# build/publish; do NOT commit it — the committed recipes stay sentinels
# (test/grappa/version_single_source_test.exs enforces that, for both).
# Why: docs/OPERATIONS.md § "Packaging (infra/packaging/)".
set -euo pipefail

AUR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

version="$("${AUR_DIR}/../version.sh")"
client_version="$("${AUR_DIR}/../version.sh" shottino)"

# pkgver is NOT the version, and since #1591 that is load-bearing rather than
# incidental. `makepkg` refuses the hyphen a semver pre-release spells its
# suffix with, so `pkgver.sh` maps the canonical number onto one makepkg
# accepts AND `vercmp` orders below the release it precedes — or refuses to
# derive at all. On a bare `X.Y.Z` (every tag cut so far) it is the identity,
# so this changes nothing for a normal release. BOTH recipes go through it:
# the client's carrier can grow a pre-release exactly the way the bouncer's
# did, and a second recipe that skipped the mapping would die at makepkg, at
# release time, on a tag.
pkgver="$("${AUR_DIR}/pkgver.sh" "${version}")"
client_pkgver="$("${AUR_DIR}/pkgver.sh" "${client_version}")"

# derive <recipe-dir> <pkgver> — fill the sentinels, checksum, regenerate.
# One function for both recipes: the client's extra `_grappaver` is a no-op
# sed on the bouncer's, which has no such line, so the two paths cannot drift
# in the part that matters (updpkgsums + printsrcinfo run identically).
derive() {
	local dir="$1" pkgver="$2"
	echo "==> ${dir}: deriving pkgver=${pkgver} (#538/#652 single source)"
	sed -i -E "s/^pkgver=.*/pkgver=${pkgver}/" "${dir}/PKGBUILD"
	# The tag that carries the source is ALWAYS the bouncer's version, even in
	# the recipe whose pkgver is not — and, since #1591, even in the recipe
	# whose pkgver is the bouncer's own MAPPED number. `v${pkgver}` would name
	# a tag nobody cut the moment a pre-release is mapped, so BOTH recipes now
	# spell the tag `_grappaver`, and this sed (a deliberate no-op on the
	# bouncer's file until then) is live on both.
	sed -i -E "s/^_grappaver=.*/_grappaver=${version}/" "${dir}/PKGBUILD"
	(
		cd "${dir}"
		echo "==> ${dir}: updpkgsums (real sha256 of the v${version} tag tarball)"
		updpkgsums
		echo "==> ${dir}: regenerating .SRCINFO from PKGBUILD"
		makepkg --printsrcinfo >.SRCINFO
	)
}

derive "${AUR_DIR}" "${pkgver}"
derive "${AUR_DIR}/shottino" "${client_pkgver}"
echo "==> recipes ready: grappa=${pkgver}, shottino=${client_pkgver} (tag v${version})"
