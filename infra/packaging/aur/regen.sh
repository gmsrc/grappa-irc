#!/usr/bin/env bash
# regen.sh — turn the committed sentinel recipe into a concrete, buildable
# and publishable one, deriving the version from the single source of truth
# (the repo-root VERSION file, #538/#652).
#
# The committed PKGBUILD/.SRCINFO carry `pkgver=@GRAPPA_VERSION@` — a sentinel
# makepkg REFUSES (its pkgver lint rejects '@'), so an UNDERIVED build fails
# LOUDLY instead of silently shipping `grappa-@GRAPPA_VERSION@`. This script
# is the ONE derivation path, shared by:
#
#   * .github/workflows/release.yml's Arch job (before `makepkg -sf`), and
#   * the human AUR publish (see README.md "Publishing to the AUR").
#
# Scripting the derivation is deliberate: BUILD ≠ PUBLISH (no AUR credentials
# live in this tree; the push to aur.archlinux.org stays a human `git push`),
# but "derive the version" must NOT be a manual step a publisher can forget —
# that is the same forget-a-step class as the drift #538 fixes.
#
# Steps: derive pkgver from the VERSION file, refresh the checksums against the tag
# tarball (updpkgsums), regenerate .SRCINFO. Run from a checkout on the
# release tag — updpkgsums fetches the `vX.Y.Z` tarball, so the tag must
# already exist.
#
# NB: this rewrites PKGBUILD in place (pkgver + sha256sums), exactly as
# updpkgsums already rewrites sha256sums. The RESULT is what you build/publish;
# do NOT commit it — the committed recipe stays the @GRAPPA_VERSION@ sentinel
# (the guard in test/grappa/version_single_source_test.exs enforces that).
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
