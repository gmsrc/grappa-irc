#!/usr/bin/env bash
# DEPRECATED SHIM (#503), kept for one release — forwards verbatim to
# `infra/docker/deploy.sh install`; the whole environment (PHX_HOST, HTTP_BIND,
# SEED_*, FRONTEND_SSL_*, …) rides through the exec unchanged. Prefer:
#
#   infra/docker/deploy.sh install
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
printf '\033[1;33m!!\033[0m  quickstart.sh is deprecated (#503) — forwarding to: infra/docker/deploy.sh install\n' >&2
exec "$REPO_ROOT/infra/docker/deploy.sh" install "$@"
