#!/bin/sh
# get.sh — one-line bootstrap for the checkout-less grappa Docker box, the
# `curl … | bash` entry point for the pre-built ghcr image:
#
#   install:  curl -fsSL https://raw.githubusercontent.com/vjt/grappa-irc/main/infra/docker/get.sh | bash
#   update:   curl -fsSL https://raw.githubusercontent.com/vjt/grappa-irc/main/infra/docker/get.sh | bash -s -- update
#
# It mirrors the files the release-image deploy path needs into $GRAPPA_HOME,
# reproducing the repo's infra/docker + infra/lib + infra/packaging layout
# (deploy.sh resolves both of its dependencies relative to itself), then execs
# deploy.sh in RELEASE mode with the requested verb — default: the bare
# install-or-update verb. Everything else is deploy.sh's job. Re-running
# re-downloads every file first.
# Why: docs/OPERATIONS.md § "The Docker deploy driver (infra/docker/)" (#503).
#
# POSIX sh, dash-clean — no `local`, no arrays, no `[[ ]]`: it runs under
# whatever `| bash` / `| sh` the operator pipes it to, and CI lints it with
# `shellcheck -s sh` + `dash -n`.

set -eu

RAW_BASE="${GRAPPA_RAW_BASE:-https://raw.githubusercontent.com/vjt/grappa-irc/main}"
# Must match deploy.sh's release-mode default: the mirrored files and the env
# file deploy.sh looks for share one home.
GRAPPA_HOME="${GRAPPA_HOME:-$HOME/.grappa}"
export GRAPPA_HOME

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

# A hand-run copy (unlike the piped one-liner) may not have curl. Check before
# any file is touched.
command -v curl >/dev/null 2>&1 || die "curl not found — install it (it is what fetched this script)."

DOCKER_DIR="$GRAPPA_HOME/infra/docker"
LIB_DIR="$GRAPPA_HOME/infra/lib"
PKG_DIR="$GRAPPA_HOME/infra/packaging"
DEPLOY="$DOCKER_DIR/deploy.sh"

# POSIX sh has no brace expansion — explicit mkdir -p per directory.
mkdir -p "$DOCKER_DIR" "$LIB_DIR" "$PKG_DIR"

# fetch URL DEST — download to a temp and move into place, so a failed
# download never leaves a half-written (yet executable) deploy.sh behind.
fetch() {
	say "Fetching $1"
	curl -fsSL "$1" -o "$2.tmp" || die "download failed: $1"
	mv "$2.tmp" "$2"
}

fetch "$RAW_BASE/infra/lib/deploy_common.sh"      "$LIB_DIR/deploy_common.sh"
# The ONE secret generator (#862): deploy.sh refuses to write an env file
# without it, so it is fetched here, not lazily.
fetch "$RAW_BASE/infra/packaging/gen-secrets.sh" "$PKG_DIR/gen-secrets.sh"
fetch "$RAW_BASE/infra/docker/deploy.sh"         "$DEPLOY"
chmod +x "$DEPLOY"

# Hand off in forced RELEASE mode — an odd layout must never flip a curl'd
# copy to source mode. PHX_HOST / GRAPPA_IMAGE / GRAPPA_PUBLISH ride through
# the exec via the environment; deploy.sh's PHX_HOST prompt reads /dev/tty,
# not the piped stdin, so `| bash` still asks.
say "Handing off to deploy.sh (release image)"
export GRAPPA_DEPLOY_MODE=release
exec "$DEPLOY" "$@"
