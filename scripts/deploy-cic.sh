#!/usr/bin/env bash
# Deploy a fresh cicchetto bundle to runtime/cicchetto-dist + notify
# the live grappa container so connected browsers see the refresh
# banner.
#
# Two-step:
#   1. `compose --profile prod run --rm cicchetto-build` — bun + Vite
#      build into runtime/cicchetto-dist/, producing an `index-<hash>.js`
#      whose hash changes iff the source did.
#   2. `POST /admin/cic-bundle-changed` — re-reads the new index.html and
#      broadcasts `{kind: "bundle_hash", hash}` on every live user-topic;
#      cic compares it against `bootBundleHash` and shows a refresh banner
#      on mismatch.
#
# Independent of `scripts/deploy.sh`: cic deploys never need a server
# restart, server deploys never trigger a cic refresh.
#
# Usage:
#   scripts/deploy-cic.sh
#
# Operator workflow: edit cicchetto/src/, then `scripts/deploy-cic.sh`.
# Browsers with the old bundle see the refresh banner within seconds.

set -euo pipefail

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"
# shellcheck source=infra/lib/cic_dist.sh
. "$(dirname "$0")/../infra/lib/cic_dist.sh"

# Assert main-checkout + main-branch BEFORE the rebuild swaps the on-disk
# bundle that is being served (#364).
require_main_checkout "deploy-cic.sh"

cd "$REPO_ROOT"

# Build into a STAGING sibling, never into the dir the live BEAM is serving.
# CIC_BUILD_OUT is scoped to the build command so the rest of this script
# (and any later compose call) sees the normal mount.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)" (#1020).
CIC_SERVED="runtime/cicchetto-dist"
CIC_BUILD_OUT="$(cic_dist_docker_stage "$CIC_SERVED")"

# The cicchetto-build container mounts only ./cicchetto and cannot read the
# repo root, so pass the version through the compose env (#538).
GRAPPA_VERSION="$("$REPO_ROOT/infra/packaging/version.sh")"
export GRAPPA_VERSION
# #1773 — same channel, same reason: the credit roll's git facts cannot be read
# from inside that container either.
GRAPPA_CREDITS="$("$REPO_ROOT/infra/packaging/credits.sh")"
export GRAPPA_CREDITS
echo "Building cicchetto dist..."
CIC_BUILD_OUT="$CIC_BUILD_OUT" docker compose "${COMPOSE_ARGS[@]}" --profile prod run --rm cicchetto-build
# Swap the finished bundle in; the promote plants the tracked .gitkeep.
cic_dist_promote "$CIC_SERVED" "$CIC_BUILD_OUT"

echo "Notifying grappa of new bundle hash..."
# /admin/cic-bundle-changed is loopback-gated, so curl it from inside the
# container. Body is the new hash on success, empty on 204 (the BEAM could
# not READ the bundle it was asked to broadcast). Goes through `_lib.sh
# in_container` — never a bare `docker exec grappa`.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
if ! hash="$(in_container curl -fsS -X POST http://localhost:4000/admin/cic-bundle-changed)"; then
    die "cic-bundle-changed POST failed — is grappa up? scripts/healthcheck.sh"
fi

# An empty body is HTTP 204 — nothing was broadcast, so no client sees the
# refresh banner. That is a FAILED deploy: fail loud, never print a ✓ here.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)" (#526).
if [ -z "$hash" ]; then
    die "cic-bundle-changed returned 204 (empty) — grappa built the dist but could NOT read it back to broadcast the hash, so NO refresh banner fired. Check that CIC_DIST_ROOT resolves to the dir the build wrote (runtime/cicchetto-dist). See issue #526."
fi

echo "✓ cic dist built + broadcast hash=$hash to all live user-topics"
