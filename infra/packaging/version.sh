#!/bin/sh
# version.sh — echo a component's single canonical version to stdout.
#
#   version.sh            grappa   (default — every pre-#1447 caller)
#   version.sh grappa     grappa
#   version.sh shottino   the terminal client
#
# This script is where "which file carries which version line" is answered,
# ONCE. It does not hold a version of its own: each component's number stays in
# its own carrier and is read from there.
#
#   grappa    the repo-root `VERSION` file. THE single source of truth for the
#             bouncer; every other carrier DERIVES from it, most of them
#             through this script. Bump by editing that file — nothing else.
#   shottino  `frontends/shottino/version.h`. A SEPARATE line on a separate
#             cadence (#1447, vjt's ruling 2026-08-16): the standalone client
#             package is stamped with it, not with the grappa tag, so
#             `shottino --version` and the package version agree.
#
# Why: docs/OPERATIONS.md § "Packaging (infra/packaging/)".
#
# The no-argument form is load-bearing and must keep meaning `grappa`: the
# FreeBSD jail build calls this bare (see the POSIX note below), as do
# build.sh and the AUR recipe generator.
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

component="${1:-grappa}"

case "${component}" in
grappa)
	# `head -1` + `tr -d` strips any trailing newline / CR so the echoed value
	# is a bare `X.Y.Z`.
	source_file="${REPO_ROOT}/VERSION"
	version="$(head -1 "${source_file}" 2>/dev/null | tr -d '\r\n')"
	;;
shottino)
	# The one `#define SHOTTINO_VERSION "X.Y.Z"` in the header. Anchored on the
	# define so the `#ifndef` guard above it cannot match, and quote-delimited
	# so a trailing comment cannot leak into the value.
	source_file="${REPO_ROOT}/frontends/shottino/version.h"
	version="$(sed -n 's/^#define SHOTTINO_VERSION "\(.*\)"$/\1/p' "${source_file}" 2>/dev/null | head -1 | tr -d '\r\n')"
	;;
*)
	printf 'version.sh: unknown component %s (want: grappa | shottino)\n' "${component}" >&2
	exit 2
	;;
esac

if [ -z "${version}" ]; then
	printf 'version.sh: could not read the %s version from %s\n' "${component}" "${source_file}" >&2
	exit 1
fi
printf '%s\n' "${version}"
