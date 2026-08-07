#!/usr/bin/env bash
# Linux/systemd entry point for the shared BEAM stop/start
# synchronization helper. The algorithm, the verbs and the escalation
# rules live in infra/lib/beam_wait.sh (#923) — this substrate needs no
# config of its own, so the file is just the stable path
# grappa.service's ExecStartPre refers to.
#
# On FreeBSD this was the PRIMARY stop/start sync mechanism because
# rc.d's `service grappa stop` is asynchronous (defect #9, 2026-06-11
# outage: a restart raced the still-draining old node into an epmd
# name collision). On Linux, `ExecStart=.../bin/grappa start` runs the
# release in the FOREGROUND under systemd `Type=exec` — systemd tracks
# that PID directly and `systemctl stop`/`restart` natively block until
# it exits (bounded by TimeoutStopSec). That closes the defect #9 race
# at the root cause, so this script is no longer load-bearing for the
# stop path.
#
# It's kept for two narrower purposes:
#   - `wait-name-free` wired into grappa.service as ExecStartPre — a
#     defense-in-depth guard against a restart-cycling edge case
#     where epmd hasn't yet reacted to a just-exited node.
#   - `wait-stopped` kept as a standalone operator tool for manually
#     troubleshooting a stuck stop (not invoked by any script here).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/lib/beam_wait.sh
. "${SCRIPT_DIR}/../lib/beam_wait.sh"

beam_wait_main "$@"
