#!/bin/sh
# FreeBSD-jail entry point for the shared BEAM stop/start synchronization
# helper. The algorithm, the verbs and the escalation rules live in
# infra/lib/beam_wait.sh (#923); this file is the jail's substrate config
# plus the call sites' stable path.
#
# Two call sites, one implementation:
#   - infra/freebsd/rc.d/grappa     grappa_stop (wait-stopped) and
#                                   grappa_start (wait-name-free)
#   - infra/freebsd/deploy.sh       cold path, after `service grappa
#                                   stop` (covers transition deploys
#                                   that stopped via a previously
#                                   installed, still-async wrapper)
#
# Both reach this path from rc.conf.d / the repo checkout, so the path
# is a contract with the INSTALLED wrapper of the previous deploy — it
# is deliberately unchanged by the #923 dedupe.

set -eu

# epmd ships with the pkg-installed Erlang; rc(8) and root shells don't
# have /usr/local paths (same pin as deploy.sh's run_as_grappa). If the
# pkg moves (erlang29) the binary vanishes from PATH and the lib's probe
# warns instead of silently degrading to BEAM-exit-only.
PATH="/usr/local/lib/erlang28/bin:${PATH}"

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=infra/lib/beam_wait.sh
. "${SCRIPT_DIR}/../lib/beam_wait.sh"

beam_wait_main "$@"
