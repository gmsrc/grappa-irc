#!/usr/bin/env bash
# Curl the grappa /healthz endpoint from INSIDE the container, so the probe
# is independent of host port binding.
#
# Usage:
#   scripts/healthcheck.sh

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

in_container curl -fsS http://localhost:4000/healthz
echo
