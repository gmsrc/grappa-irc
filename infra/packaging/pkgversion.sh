#!/bin/sh
# pkgversion.sh — echo the version field nfpm STAMPS into a package, for one
# component in one format.
#
#   pkgversion.sh deb grappa     the .deb `Version:` of the bouncer package
#   pkgversion.sh rpm grappa     the .rpm `Version` of its NEVRA
#   pkgversion.sh deb shottino   ditto for the standalone client package
#   pkgversion.sh rpm shottino
#
# WHY THIS IS NOT version.sh (GH #1594). `version.sh` answers "which file
# carries this component's number", and it is the SOURCE of truth. This script
# answers a different question — "what does the packager write down" — and the
# two answers DIFFER the moment the number carries a pre-release. nfpm does not
# ship the string it is given: it parses it as semver and re-spells the
# pre-release with a tilde, because `~` is how both dpkg and rpm express
# "sorts below the release it precedes".
#
# Cutting v1.3.0-rc1 is where that mattered. `1.3.0-rc1` reached the resolvers
# as `1.3.0~rc1`, which is strictly less than `1.3.0`, so shottino's takeover
# boundary captured the release candidate of the very release that defines the
# boundary and the two packages became mutually uninstallable. Nothing in the
# pipeline noticed, because the only version proofs it had compared the CLIENT
# package against the CLIENT's own carrier — the bouncer's stamped number was
# unasserted in both formats. This script is the shared oracle those four
# proofs now use.
#
# THE MAP IS MEASURED, not derived from nfpm's source or from semver's text.
# nfpm 2.43.0 (the version build.sh pins), minimal config, one package built
# per row, field read off the artefact with `dpkg-deb -f`/`rpm -qp`:
#
#   VERSION file      deb Version      rpm Version      rpm Release
#   1.3.0             1.3.0            1.3.0            1
#   1.3.0-rc1         1.3.0~rc1        1.3.0~rc1        1
#   1.3.0-rc.1        1.3.0~rc.1       1.3.0~rc.1       1
#   1.3.0-rc-1        1.3.0~rc-1       1.3.0~rc_1       1
#   1.3.0+foo         1.3.0+foo        1.3.0+foo        1
#   1.3.0-rc1+foo     1.3.0~rc1+foo    1.3.0~rc1+foo    1
#
# So: the FIRST `-` becomes `~` in both formats, and on rpm every FURTHER `-`
# becomes `_` — rpm reserves `-` as the Version/Release separator and cannot
# carry one inside Version. That single divergent row is why this takes a
# format argument instead of answering once. `Release` is nfpm's default `1`
# in every row; a pre-release is NOT split out into it.
#
# NO DEFAULT ARGUMENTS, unlike version.sh's load-bearing bare form. An oracle
# that guesses the format would compare a .rpm against the deb spelling and
# agree on every version without a hyphen — which is every version this repo
# has ever cut but one. It must refuse instead.
#
# POSIX sh, same dialect as its sibling: it is reached from CI shell and from
# the bats suite, and the derived POSIX-parse gate covers it by line 1.
set -eu

# shellcheck disable=SC1007
SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"

if [ "$#" -ne 2 ]; then
	printf 'pkgversion.sh: usage: pkgversion.sh <deb|rpm> <grappa|shottino>\n' >&2
	exit 2
fi

format="$1"
component="$2"

case "${format}" in
deb | rpm) ;;
*)
	printf 'pkgversion.sh: unknown format %s (want: deb | rpm)\n' "${format}" >&2
	exit 2
	;;
esac

# The component name is validated by version.sh, which exits 2 on an unknown
# one — no second allowlist to drift out of step with it.
source_version="$("${SCRIPT_DIR}/version.sh" "${component}")"

case "${format}" in
deb)
	# First `-` only: `s///` without `g`.
	printf '%s\n' "${source_version}" | sed 's/-/~/'
	;;
rpm)
	printf '%s\n' "${source_version}" | sed 's/-/~/; s/-/_/g'
	;;
esac
