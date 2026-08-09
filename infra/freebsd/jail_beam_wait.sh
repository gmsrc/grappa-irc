#!/bin/sh
# FreeBSD-jail entry point for the shared BEAM stop/start synchronization
# helper. The algorithm, verbs and escalation rules live in
# infra/lib/beam_wait.sh; this file is the jail's substrate config.
#
# Two call sites, one implementation:
#   - infra/freebsd/rc.d/grappa     grappa_stop (wait-stopped) and
#                                   grappa_start (wait-name-free)
#   - infra/freebsd/deploy.sh       cold path, after `service grappa stop`
#
# This PATH is a contract with the wrapper the PREVIOUS deploy installed —
# do not move or rename the file.
# Why: docs/OPERATIONS.md § "The FreeBSD jail rails (infra/freebsd/)" (#923).

set -eu

# epmd ships with the pkg-installed Erlang, and rc(8) / root shells have
# no /usr/local paths. If the pkg moves (erlang29) the binary leaves PATH
# and the lib's probe warns instead of silently degrading.
PATH="/usr/local/lib/erlang28/bin:${PATH}"

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=infra/lib/beam_wait.sh
. "${SCRIPT_DIR}/../lib/beam_wait.sh"

beam_wait_main "$@"
