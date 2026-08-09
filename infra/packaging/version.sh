#!/bin/sh
# version.sh — echo grappa's single canonical version to stdout.
#
# THE single source of truth is the repo-root `VERSION` file; every other
# carrier DERIVES from it, most of them through this script. Bump the
# version by editing that file — nothing else.
# Why: docs/OPERATIONS.md § "Packaging (infra/packaging/)".
#
# POSIX sh, NOT bash: the FreeBSD jail build (infra/freebsd/jail_cic_build.sh)
# runs /bin/sh with no bash/bun port and calls this to derive the version.
# Always EXECUTED (never sourced), so `$0` locates the script.
set -eu

# No `dirname --` / `cd --`: BSD dirname (the FreeBSD jail) doesn't accept the
# end-of-options `--`, and $0 is always an invoked path (never starts with -).
#
# `CDPATH= cd` is an env-prefixed command (clear CDPATH for this cd only, so a
# user's CDPATH cannot teleport it and mis-root the repo), not a botched
# assignment — hence the SC1007 disable.
# shellcheck disable=SC1007
SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1007
REPO_ROOT="$(CDPATH= cd "${SCRIPT_DIR}/../.." && pwd)"

# `head -1` + `tr -d` strips any trailing newline / CR so the echoed value is
# a bare `X.Y.Z`.
version="$(head -1 "${REPO_ROOT}/VERSION" 2>/dev/null | tr -d '\r\n')"
if [ -z "${version}" ]; then
	printf 'version.sh: could not read version from %s/VERSION\n' "${REPO_ROOT}" >&2
	exit 1
fi
printf '%s\n' "${version}"
