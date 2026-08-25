#!/bin/sh
# credits.sh — echo the build's git credits payload, as ONE line of JSON.
#
#   {"sha":"a453325e","date":"2026-08-25T18:04:11+02:00",
#    "contributors":[{"name":"…","commits":903},…]}
#
# Sibling of version.sh, and deliberately shaped like it: the cic build runs
# in containers that mount ONLY ./cicchetto (cicchetto/vite.config.ts:30-39),
# so the repo root — and therefore git — is out of reach in there. Every
# cic-build entrypoint already derives GRAPPA_VERSION from version.sh and
# exports it before the container starts; this script is the second half of
# that same channel, for the three facts a credit roll needs and a browser
# cannot have (#1773). A `git shortlog` inside vite.config.ts would find no
# repo and bake an EMPTY roll, silently, on every containerised build.
#
# POSIX sh, NOT bash, for the same reason version.sh is: the FreeBSD jail
# build (infra/freebsd/jail_cic_build.sh) runs /bin/sh with no bash port and
# calls this to derive the payload. Always EXECUTED (never sourced), so `$0`
# locates the script.
#
# ── Why this NEVER fails, unlike the GRAPPA_VERSION throw in vite.config.ts ──
#
# Two of the launchers that must call it have no `.git` BY CONSTRUCTION, and
# both are RELEASE builds:
#
#   * infra/packaging/aur/PKGBUILD builds from the tag's source TARBALL —
#     release.yml asserts that shape outright ("tarball → no .git → bare");
#   * Dockerfile.release .dockerignore's `.git`, which is exactly why the
#     comment in it says Grappa.Version "takes its no-git path".
#
# So a hard failure on a missing repo would break precisely the two builds
# that ship. This script instead reports the absence honestly — `sha:null`,
# `date:null`, `contributors:[]` — which is the SAME posture
# `Grappa.Version.verify_build_sha/2` already takes, where a positively
# identified no-git build is `{:skip, :no_git}` and only a BROKEN snapshot is
# an error. The loud half stays where it belongs: vite still refuses to build
# when GRAPPA_CREDITS is UNSET, because that means a wrapper forgot to plumb
# it, which is the failure the throw exists to catch.
#
# Why: docs/OPERATIONS.md § "Packaging (infra/packaging/)".
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

sha=""
date=""
shortlog=""

# `.git` is a directory in a normal checkout and a FILE in a `git worktree`
# (it points at the shared gitdir); either is a source build. Absent entirely
# is a release tarball / package. Tested explicitly rather than letting git
# walk upwards: a checkout extracted INSIDE some other repo must report its
# own absence, not that repo's history.
if [ -e "${REPO_ROOT}/.git" ]; then
	# Every probe degrades to empty on failure and none of them aborts the
	# script — same contract as Grappa.Version.GitProbe, and for the same
	# reason: a missing git binary, an unborn HEAD or a refused checkout
	# (git's "dubious ownership") must yield a smaller payload, never a
	# broken build.
	sha="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || true)"
	date="$(git -C "${REPO_ROOT}" log -1 --format=%cI 2>/dev/null || true)"
	# `--no-merges` so a merge does not credit the merger with the work of
	# whoever authored the branch; HEAD is named explicitly so shortlog reads
	# the revision instead of waiting on stdin.
	shortlog="$(git -C "${REPO_ROOT}" shortlog -sn --no-merges HEAD 2>/dev/null || true)"
fi

# ONE awk pass builds the whole payload: the contributor rows come in on
# stdin, the two scalars on -v. LC_ALL=C keeps substr/length byte-oriented, so
# a multi-byte name is copied through byte by byte and reassembles exactly —
# awk never reorders what it concatenates.
printf '%s' "${shortlog}" | LC_ALL=C awk -v sha="${sha}" -v head_date="${date}" '
	# JSON string literal. Character-by-character rather than gsub: the
	# replacement text of gsub gives `\` and `&` their own meanings, which is
	# how an escaper comes to corrupt exactly the input it exists for.
	function jsonstr(s,   out, i, c) {
		out = "\""
		for (i = 1; i <= length(s); i++) {
			c = substr(s, i, 1)
			if (c == "\\") {
				out = out "\\\\"
			} else if (c == "\"") {
				out = out "\\\""
			} else if (c < " ") {
				# git forbids CR/LF in an author name, so this is
				# unreachable in practice — but the payload has to be
				# parseable by construction, not by trust.
				out = out " "
			} else {
				out = out c
			}
		}
		return out "\""
	}

	function jsonornull(s) {
		return s == "" ? "null" : jsonstr(s)
	}

	{
		# `shortlog -sn` emits "<count>\t<name>"; a line without the tab is
		# not a contributor row and is dropped rather than guessed at.
		tab = index($0, "\t")
		if (tab == 0) {
			next
		}
		if (n > 0) {
			rows = rows ","
		}
		rows = rows "{\"name\":" jsonstr(substr($0, tab + 1)) ",\"commits\":" ($1 + 0) "}"
		n++
	}

	END {
		printf "{\"sha\":%s,\"date\":%s,\"contributors\":[%s]}\n",
			jsonornull(sha), jsonornull(head_date), rows
	}
'
