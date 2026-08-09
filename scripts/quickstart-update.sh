#!/usr/bin/env bash
# DEPRECATED SHIM (#503), kept for one release — forwards verbatim to
# `infra/docker/deploy.sh update` (--no-pull / --force-hot / --force-cold ride
# through). Prefer:
#
#   infra/docker/deploy.sh update
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
printf '\033[1;33m!!\033[0m  quickstart-update.sh is deprecated (#503) — forwarding to: infra/docker/deploy.sh update\n' >&2
exec "$REPO_ROOT/infra/docker/deploy.sh" update "$@"
