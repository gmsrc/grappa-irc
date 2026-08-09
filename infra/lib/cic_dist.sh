# shellcheck shell=sh
# infra/lib/cic_dist.sh — build BESIDE the served cic bundle, then swap (#1020).
#
# NEVER aim a builder at the directory the running BEAM serves: vite empties
# `outDir` before it writes, so the served tree is EMPTY for the whole build.
# Build into `<served>.next` instead, then promote with two renames.
# Why: docs/OPERATIONS.md § "The shared deploy library (infra/lib/)" (#1020).
#
# The staging path must stay a SIBLING of the served one (both inside
# `runtime/`): rename(2) cannot cross filesystems, and a cross-device `mv`
# degrades to copy-then-delete, which is neither atomic nor fast.
#
# This file is SOURCED, never executed — POSIX sh, no `local`, no bashisms, so
# the FreeBSD jail's /bin/sh build body can source it as-is (same contract as
# beam_wait.sh / deploy_common.sh).
#
# Consumers (one algorithm, no per-substrate copy):
#   - infra/freebsd/jail_cic_build.sh   npm + vite, inside `su -l grappa`
#   - infra/linux/cic_build.sh          bun + vite, via `sudo -u grappa`
#   - scripts/deploy.sh                 the compose oneshot (dev/operator)
#   - scripts/deploy-cic.sh             the compose oneshot, cic-only deploy
#   - infra/docker/deploy.sh            the compose oneshot, standalone install
#
# infra/packaging/build.sh is NOT a consumer: it already builds into a staging
# tree under `staging/usr/share/grappa/` that no server is serving.

# Echo the staging path for a served bundle directory. ONE derivation, because
# every consumer needs the name twice — once to aim the builder at it, once to
# promote it — and two spellings of it is a silent no-op deploy.
cic_dist_staging() {
	if [ -z "${1:-}" ]; then
		echo "cic_dist_staging: refusing to derive a staging path from an empty served path" >&2
		return 1
	fi
	printf '%s.next\n' "$1"
}

# Prepare the staging dir the compose oneshot bind-mounts, and echo it in the
# `./`-prefixed shape compose needs (a source with no `./` or `/` is parsed as
# a NAMED VOLUME, not a host path). The dir must pre-exist or Docker creates it
# root-owned and the UID-1000 container cannot write vite's output into it.
cic_dist_docker_stage() {
	_cic_staged="$(cic_dist_staging "$1")" || return 1
	rm -rf "${_cic_staged}"
	mkdir -p "${_cic_staged}"
	printf './%s\n' "${_cic_staged}"
}

# Swap a freshly built bundle into the served path. Leaves the served tree
# UNTOUCHED on any refusal — callers run under `set -e`, so an aborted build
# never reaches here and the previous bundle keeps serving.
cic_dist_promote() {
	_cic_served="${1:-}"
	_cic_staged="${2:-}"
	if [ -z "${_cic_served}" ] || [ -z "${_cic_staged}" ]; then
		echo "cic_dist_promote: served and staged paths are both required" >&2
		return 1
	fi

	# A vite build can exit 0 having written nothing reachable, and promoting
	# that would swap an EMPTY tree into the served path. index.html is the
	# one file the server must find: Bundle.current_hash/0 parses it and the
	# history-fallback serves it.
	if [ ! -f "${_cic_staged}/index.html" ]; then
		echo "cic_dist_promote: ${_cic_staged}/index.html is missing — refusing to promote a tree that is not a bundle; the previous one keeps serving" >&2
		return 1
	fi

	# `runtime/cicchetto-dist/.gitkeep` is TRACKED (see .gitignore), so it
	# belongs to the tree that LANDS: plant it BEFORE the swap, never restore
	# it after.
	# Why: docs/OPERATIONS.md § "The shared deploy library (infra/lib/)" (#1020).
	touch "${_cic_staged}/.gitkeep"

	_cic_prev="${_cic_served}.prev"
	rm -rf "${_cic_prev}"
	# `mv a b` where b is an EXISTING DIRECTORY moves a INSIDE b. The served
	# path must therefore be gone — not emptied, GONE — before the second
	# rename, or the new bundle lands at <served>/<staged-basename>/ and the
	# server keeps serving the old one with no error anywhere.
	if [ -d "${_cic_served}" ]; then
		mv "${_cic_served}" "${_cic_prev}"
	fi
	mv "${_cic_staged}" "${_cic_served}"
	# Only now is the previous bundle disposable. Dropping it is the
	# stale-chunk cleanup: the old content-hashed assets go with the old
	# directory instead of accreting in the served one.
	rm -rf "${_cic_prev}"
}
