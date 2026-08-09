#!/usr/bin/env bash
# Linux/systemd entry point for the shared BEAM stop/start
# synchronization helper. The algorithm, the verbs and the escalation
# rules live in infra/lib/beam_wait.sh (#923) — this substrate needs no
# config of its own, so the file is just the stable path
# grappa.service's ExecStartPre refers to.
#
# systemd `Type=exec` makes `systemctl stop`/`restart` block until the
# release exits, so this is NOT load-bearing for the stop path here. Two
# narrower uses remain:
#   - `wait-name-free` as grappa.service's ExecStartPre — defense in
#     depth against a restart cycle where epmd has not yet reacted to a
#     just-exited node.
#   - `wait-stopped` as a standalone operator tool for a stuck stop
#     (invoked by no script here).
# Why: docs/OPERATIONS.md § "Native Linux and the cloud one-click box (infra/linux/, infra/cloud/)".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/lib/beam_wait.sh
. "${SCRIPT_DIR}/../lib/beam_wait.sh"

beam_wait_main "$@"
