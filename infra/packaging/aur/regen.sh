#!/usr/bin/env bash
# regen.sh — turn the committed sentinel recipe into a concrete, buildable
# and publishable one, deriving the version from the repo-root VERSION file.
#
# The committed PKGBUILD/.SRCINFO carry `pkgver=@GRAPPA_VERSION@`; this is the
# ONE path that fills it, shared by:
#
#   * .github/workflows/release.yml's Arch job (before `makepkg -sf`), and
#   * the human AUR publish (see README.md "Publishing to the AUR").
#
# Steps: derive pkgver from the VERSION file, refresh the checksums against the tag
# tarball (updpkgsums), regenerate .SRCINFO. Run from a checkout on the
# release tag — updpkgsums fetches the `vX.Y.Z` tarball, so the tag must
# already exist.
#
# NB: this rewrites PKGBUILD in place (pkgver + sha256sums). The RESULT is what
# you build/publish; do NOT commit it — the committed recipe stays the
# @GRAPPA_VERSION@ sentinel (test/grappa/version_single_source_test.exs
# enforces that).
# Why: docs/OPERATIONS.md § "Packaging (infra/packaging/)".
set -euo pipefail

AUR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

version="$("${AUR_DIR}/../version.sh")"
echo "==> deriving pkgver=${version} from the VERSION file (#538/#652 single source)"
sed -i -E "s/^pkgver=.*/pkgver=${version}/" "${AUR_DIR}/PKGBUILD"

cd "${AUR_DIR}"
echo "==> updpkgsums (real sha256 of the v${version} tag tarball)"
updpkgsums
echo "==> regenerating .SRCINFO from PKGBUILD"
makepkg --printsrcinfo >.SRCINFO
echo "==> recipe ready: pkgver=${version}"
