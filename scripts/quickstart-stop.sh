#!/usr/bin/env bash
# DEPRECATED SHIM (#503) — forwards to `infra/docker/deploy.sh stop`.
#
# Absorbed into the verb-dispatched consumer of the shared deploy lib. Kept
# for one release; forwards verbatim (--volumes / -v ride through). Prefer:
#
#   infra/docker/deploy.sh stop
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
printf '\033[1;33m!!\033[0m  quickstart-stop.sh is deprecated (#503) — forwarding to: infra/docker/deploy.sh stop\n' >&2
exec "$REPO_ROOT/infra/docker/deploy.sh" stop "$@"
