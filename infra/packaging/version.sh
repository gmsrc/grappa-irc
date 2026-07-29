#!/bin/sh
# version.sh — echo grappa's single canonical version to stdout.
#
# THE single source of truth for the version across every carrier is
# `@version` in mix.exs (#538). Everything else DERIVES from it — there is no
# second hand-edited copy to keep in sync:
#
#   * build.sh sources this to export GRAPPA_VERSION, which nfpm.yaml
#     interpolates into the .deb (and, once #438 lands, the .rpm);
#   * release.yml's Arch job + aur/regen.sh run this to fill PKGBUILD's
#     `@GRAPPA_VERSION@` pkgver sentinel before makepkg;
#   * every cic build entrypoint (scripts/bun.sh, the compose cicchetto-build
#     launchers, the Arch/FreeBSD/Linux prod builds) exports GRAPPA_VERSION
#     from this so vite bakes it into <meta cicchetto-version> — the container
#     builds mount only ./cicchetto and cannot read mix.exs themselves.
#
# POSIX sh, NOT bash: the FreeBSD jail build (infra/freebsd/jail_cic_build.sh)
# runs /bin/sh with no bash/bun port and calls this to derive the version.
# Always EXECUTED (never sourced), so `$0` locates the script.
#
# Bump the version by editing mix.exs `@version` — nothing else.
set -eu

# No `dirname --` / `cd --`: BSD dirname (the FreeBSD jail) doesn't accept the
# end-of-options `--`, and $0 is always an invoked path (never starts with -).
SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd "${SCRIPT_DIR}/../.." && pwd)"

version="$(grep -oE '@version "[^"]+"' "${REPO_ROOT}/mix.exs" | head -1 | sed -E 's/@version "([^"]+)"/\1/')"
if [ -z "${version}" ]; then
	printf 'version.sh: could not read @version from %s/mix.exs\n' "${REPO_ROOT}" >&2
	exit 1
fi
printf '%s\n' "${version}"
