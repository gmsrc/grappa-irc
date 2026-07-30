#!/usr/bin/env bash
# DEPRECATED SHIM (#503) — forwards to `infra/docker/deploy.sh update`.
#
# Absorbed into the verb-dispatched consumer of the shared deploy lib. The
# update verb is now smarter than this script ever was: instead of always
# recreating, it classifies hot-vs-cold via Grappa.Deploy.Preflight (HOT →
# POST /admin/reload, sessions preserved; COLD → recreate). Kept for one
# release; forwards verbatim (--no-pull / --force-hot / --force-cold ride
# through). Prefer:
#
#   infra/docker/deploy.sh update
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
printf '\033[1;33m!!\033[0m  quickstart-update.sh is deprecated (#503) — forwarding to: infra/docker/deploy.sh update\n' >&2
exec "$REPO_ROOT/infra/docker/deploy.sh" update "$@"
