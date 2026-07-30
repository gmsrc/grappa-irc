#!/usr/bin/env bash
# DEPRECATED SHIM (#503) — forwards to `infra/docker/deploy.sh install`.
#
# The three quickstart scripts (quickstart.sh / -update.sh / -stop.sh) were
# absorbed into one verb-dispatched consumer of the shared deploy lib
# (infra/docker/deploy.sh). This shim is kept for one release so existing
# muscle memory + docs keep working; it forwards verbatim — the whole
# environment (PHX_HOST, HTTP_BIND, SEED_*, FRONTEND_SSL_*, …) rides through
# the exec unchanged. Prefer:
#
#   infra/docker/deploy.sh install
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
printf '\033[1;33m!!\033[0m  quickstart.sh is deprecated (#503) — forwarding to: infra/docker/deploy.sh install\n' >&2
exec "$REPO_ROOT/infra/docker/deploy.sh" install "$@"
