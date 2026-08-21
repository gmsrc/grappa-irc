#!/usr/bin/env bash
# Operator Docker deploy — auto-detects hot-vs-cold via the shared
# Grappa.Deploy.Preflight classifier, then dispatches.
#
# Thin consumer of the shared deploy algorithm in
# infra/lib/deploy_common.sh — the same lib that drives
# infra/freebsd/deploy.sh (jail) and infra/linux/deploy.sh (systemd) — and,
# since #1384, of the Docker substrate's ONE hook set in
# infra/lib/deploy_docker.sh, shared with infra/docker/deploy.sh. This script
# sets config, flips this substrate's feature toggles, and supplies the two
# things that are its own: the compose invocation (with the host's personal
# override) and the done banner.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)" (#503).
#
# Cic deploys are orthogonal — scripts/deploy-cic.sh handles the Vite
# bundle + cic-bundle-changed broadcast independently.
#
# Usage:
#   scripts/deploy.sh                # auto-detect
#   scripts/deploy.sh --force-hot
#   scripts/deploy.sh --force-cold

set -euo pipefail

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

# Assert main-checkout + main-branch BEFORE any side effect — the git pull
# below mutates REPO_ROOT (#364).
require_main_checkout "deploy.sh"

cd "$REPO_ROOT"

# ---- lib config + feature toggles -----------------------------------
DEPLOY_SELF_REL="scripts/deploy.sh"
DEPLOY_USAGE="[--force-hot|--force-cold]"
DEPLOY_FEATURE_FORCE_FLAGS=1
DEPLOY_FEATURE_DEFER=0
DEPLOY_FEATURE_NOTHING_TO_DO=0
DEPLOY_FEATURE_REEXEC=1
DEPLOY_FEATURE_MARKER=1
DEPLOY_FEATURE_PREV_SHA_CARRY=1
DEPLOY_SEED_RETRY_HINT="scripts/mix.sh grappa.seed_themes"
DEPLOY_RESTART_HINT="scripts/deploy.sh --force-cold"

# ---- substrate hooks ------------------------------------------------
# ONE hook set for this substrate, shared with `infra/docker/deploy.sh
# update` (#1384) — including the #1377 preconditions, which moved into it
# unchanged. What this entry point contributes is the compose invocation:
# `COMPOSE_ARGS` carries the host's personal `compose.override.yaml`, which
# the standalone driver deliberately does not read.
DOCKER_COMPOSE=(docker compose "${COMPOSE_ARGS[@]}")
# shellcheck source=infra/lib/deploy_docker.sh
. "$REPO_ROOT/infra/lib/deploy_docker.sh"

substrate_done_banner() {
	# Docker success wording, no [deploy] prefix — PINNED by
	# deploy_reload_verify_test.bats. $1 = retries taken (unused here).
	if [ "$MODE" = hot ]; then
		echo "✓ hot-deploy complete (sessions preserved, container ID unchanged)"
	else
		echo "✓ cold-deploy complete (sessions reset, new container)"
	fi
}

# ---- run ------------------------------------------------------------
# shellcheck source=infra/lib/deploy_common.sh
. "$REPO_ROOT/infra/lib/deploy_common.sh"

deploy_main "$@"
