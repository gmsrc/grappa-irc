#!/usr/bin/env bash
# Build cicchetto's static SPA into runtime/cicchetto-dist, as the
# grappa user.
#
# Usage: infra/linux/cic_build.sh [repo_root]
# Idempotent — safe to re-run; `bun install` is a no-op when the
# lockfile is already satisfied.

set -euo pipefail

REPO_ROOT="${1:-/home/grappa/grappa}"
CIC_DIR="${REPO_ROOT}/cicchetto"
OUT_DIR="${REPO_ROOT}/runtime/cicchetto-dist"
GRAPPA_USER="${GRAPPA_USER:-grappa}"

# #1020 — the running BEAM serves OUT_DIR per request, so vite must not write
# into it: it builds into a staging sibling and the shared lib renames that
# into place. The lib is sourced from the SCRIPT's own dir — the arg only
# names the checkout the bundle is built FROM.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CIC_DIST_LIB="${SCRIPT_DIR}/../lib/cic_dist.sh"
# shellcheck source=infra/lib/cic_dist.sh
. "${CIC_DIST_LIB}"
STAGE_DIR="$(cic_dist_staging "${OUT_DIR}")"

# #538/#652 — vite bakes GRAPPA_VERSION into <meta cicchetto-version>; version.sh
# reads it off the repo-root VERSION file. `sudo -u` scrubs the env, so it is
# injected into the run_as_grappa command string below.
GRAPPA_VERSION="$("${REPO_ROOT}/infra/packaging/version.sh")"

# #1773 — the credit roll's git facts (sha, date, per-author commit counts),
# same channel and same env-scrubbing constraint.
GRAPPA_CREDITS="$("${REPO_ROOT}/infra/packaging/credits.sh")"
# Unlike the version — a bare X.Y.Z — this payload carries contributor NAMES,
# and a name can hold an apostrophe (O'Brien). It is spliced into a
# single-quoted assignment inside a `sudo bash -c` string, where one raw
# apostrophe would close the quote and hand the rest of the JSON to the shell
# as code. `'\''` is the POSIX idiom for a literal quote inside single quotes.
GRAPPA_CREDITS_SQ="${GRAPPA_CREDITS//\'/\'\\\'\'}"

# PATH must include ~grappa/.local/bin, where install_toolchain.sh put bun:
# `sudo -u ... bash -c` otherwise falls back to the system default PATH.
run_as_grappa() {
	sudo -u "${GRAPPA_USER}" -H bash -c "export PATH=\"\$HOME/.local/bin:\$HOME/.asdf/shims:\$PATH\"; $1"
}

echo "[cic_build] bun install && bun run build (outDir=${STAGE_DIR} → ${OUT_DIR})"
# Buffer the output and show it only on failure — a clean build is noisy
# and the interesting signal is the exit code.
log="$(mktemp)"
trap 'rm -f "${log}"' EXIT
if ! run_as_grappa "export GRAPPA_VERSION='${GRAPPA_VERSION}'; export GRAPPA_CREDITS='${GRAPPA_CREDITS_SQ}'; cd '${CIC_DIR}' && bun install && bun run build -- --outDir '${STAGE_DIR}' --emptyOutDir" >"${log}" 2>&1; then
	echo "[cic_build] ERROR: build failed — output:" >&2
	cat "${log}" >&2
	exit 1
fi
# Swap as grappa, like every other step here: the renames need write on
# runtime/, and as root they would plant a root-owned .gitkeep inside a
# grappa-owned tree.
run_as_grappa ". '${CIC_DIST_LIB}'; cic_dist_promote '${OUT_DIR}' '${STAGE_DIR}'"

echo "[cic_build] done — ${OUT_DIR}"
