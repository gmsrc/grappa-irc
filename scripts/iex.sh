#!/usr/bin/env bash
# Attach an interactive IEx shell to the LIVE grappa node via Erlang
# distribution (remsh) — a thin alias for `bin/grappa remote-shell`.
#
# Usage:
#   scripts/iex.sh                      # iex --remsh into the running node
#   scripts/iex.sh --batch -e '<expr>'  # eval one expr on the live node
#
# NEVER turn this back into `iex -S mix`: that boots a SECOND
# Grappa.Application.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)" (#364).

exec "$(dirname "$0")/../bin/grappa" remote-shell "$@"
