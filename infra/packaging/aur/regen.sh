#!/usr/bin/env bash
# regen.sh — turn the committed sentinel recipe into a concrete, buildable
# and publishable one, deriving the version from the repo-root VERSION file.
#
# TWO recipes since #1447, because they carry TWO version lines:
#
#   ./PKGBUILD           the bouncer      pkgver=@GRAPPA_VERSION@
#   ./shottino/PKGBUILD  the client       pkgver=@SHOTTINO_VERSION@
#                                         _grappaver=@GRAPPA_VERSION@
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

# derive <recipe-dir> <pkgver> — fill the sentinels, checksum, regenerate.
# One function for both recipes: the client's extra `_grappaver` is a no-op
# sed on the bouncer's, which has no such line, so the two paths cannot drift
# in the part that matters (updpkgsums + printsrcinfo run identically).
derive() {
	local dir="$1" pkgver="$2"
	echo "==> ${dir}: deriving pkgver=${pkgver} (#538/#652 single source)"
	sed -i -E "s/^pkgver=.*/pkgver=${pkgver}/" "${dir}/PKGBUILD"
	# The tag that carries the source is ALWAYS the bouncer's version, even in
	# the recipe whose pkgver is not.
	sed -i -E "s/^_grappaver=.*/_grappaver=${version}/" "${dir}/PKGBUILD"
	(
		cd "${dir}"
		echo "==> ${dir}: updpkgsums (real sha256 of the v${version} tag tarball)"
		updpkgsums
		echo "==> ${dir}: regenerating .SRCINFO from PKGBUILD"
		makepkg --printsrcinfo >.SRCINFO
	)
}

derive "${AUR_DIR}" "${version}"
derive "${AUR_DIR}/shottino" "${client_version}"
echo "==> recipes ready: grappa=${version}, shottino=${client_version}"
