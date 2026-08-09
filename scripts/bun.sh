#!/usr/bin/env bash
# Run a bun command inside an oven/bun:1 container against cicchetto/.
#
# Usage:
#   scripts/bun.sh install
#   scripts/bun.sh add phoenix
#   scripts/bun.sh run build
#   scripts/bun.sh run check                    # biome + tsc over src AND e2e (#484)
#   scripts/bun.sh run test                     # vitest (cic unit tests in jsdom)
#
# Canonical "which test runner do I use?" docs: docs/TESTING.md.
#
# cicchetto/ (the SolidJS PWA) is bind-mounted from SRC_ROOT at /app, so each
# worktree builds from its own source. bun is dev-only: `run build` writes
# `cicchetto/dist/` for local preview, NOT what production serves (that is
# `scripts/deploy.sh` → `runtime/cicchetto-dist/`).
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

# oven/bun image, digest-pinned (#103); the tag stays for readability.
# Refresh on an intentional bump:
#   docker buildx imagetools inspect oven/bun:1 --format '{{.Manifest.Digest}}'
readonly BUN_IMAGE="oven/bun:1@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4"

CICCHETTO_DIR="$SRC_ROOT/cicchetto"
# Host bind-mount under main's runtime/, so the download cache is shared by
# every worktree and inherits host ownership (the --user override writes to it).
BUN_CACHE_DIR="$REPO_ROOT/runtime/bun-cache"
mkdir -p "$CICCHETTO_DIR" "$BUN_CACHE_DIR"

# #538 — vite bakes GRAPPA_VERSION into <meta cicchetto-version>. This
# container mounts ONLY cicchetto/, so derive the version on the host and pass
# it in via -e below. vite.config.ts fails loud if it is unset, so set it for
# every verb.
GRAPPA_VERSION="$("$SRC_ROOT/infra/packaging/version.sh")"
export GRAPPA_VERSION

# Run bun inside the oven/bun:1 oneshot. Args are the trailing `docker run`
# operands (extra flags + image + `bun` + bun args), so the implicit install
# and the real invocation share one definition of the mount/uid/cache wiring.
run_bun() {
    # Honor CONTAINER_UID/GID like every compose service does: runtime/bun-cache
    # is SHARED with the compose `cicchetto-build` path, and writing it under
    # two different owners gives intermittent EACCES. HOME=/tmp is a tmpfs so
    # bun's tempdir writes succeed under the dropped UID.
    local uid gid
    uid="${CONTAINER_UID:-$(id -u)}"
    gid="${CONTAINER_GID:-$(id -g)}"
    docker run --rm -i \
        --user "$uid:$gid" \
        -v "$CICCHETTO_DIR:/app" \
        -v "$BUN_CACHE_DIR:/cache" \
        --tmpfs "/tmp:exec,uid=$uid,gid=$gid" \
        -e HOME=/tmp \
        -e BUN_INSTALL_CACHE_DIR=/cache \
        -e GRAPPA_VERSION \
        -w /app \
        "$@"
}

# Self-heal a fresh worktree / clone: cicchetto/node_modules and
# cicchetto/e2e/node_modules are PER-WORKTREE (unlike the shared download
# cache), so without this the first `run test` / `run check` dies with an
# absent toolchain reported as a missing command or a type error. The
# install-family verbs manage node_modules themselves — skip those.
# Why: docs/TESTING.md § "Architecture: why the scripts exist" (#484).
case "${1:-}" in
    install | add | remove | update | outdated | pm | ci | link | unlink) ;;
    *)
        if [ ! -d "$CICCHETTO_DIR/node_modules" ]; then
            printf 'scripts/bun.sh: cicchetto/node_modules missing — running bun install...\n' >&2
            run_bun "$BUN_IMAGE" bun install >&2
        fi
        if [ ! -d "$CICCHETTO_DIR/e2e/node_modules" ]; then
            printf 'scripts/bun.sh: cicchetto/e2e/node_modules missing — running bun install --cwd e2e...\n' >&2
            run_bun "$BUN_IMAGE" bun install --cwd e2e >&2
        fi
        ;;
esac

# Vite dev/preview binds 0.0.0.0:5173 inside the container. Expose the port to
# the host (and the LAN, for iPhone PWA install testing) only for those two
# verbs — every other verb is short-lived and never serves traffic.
PORT_ARGS=()
if [ "${1:-}" = "run" ] && { [ "${2:-}" = "dev" ] || [ "${2:-}" = "preview" ]; }; then
    PORT_ARGS=(-p 5173:5173)
fi

run_bun "${PORT_ARGS[@]}" "$BUN_IMAGE" bun "$@"
