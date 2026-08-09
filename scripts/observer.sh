#!/usr/bin/env bash
# Attach observer_cli to the LIVE grappa node.
#
# observer_cli is a TUI runtime introspector: every supervised process, mailbox
# depth, memory, scheduler load of the RUNNING system.
#
# Usage:
#   scripts/observer.sh
#
# Runs a THROWAWAY node (obs-$$) that points observer_cli AT the live node over
# Erlang distribution. `mix run --no-start --no-compile` loads the code path so
# `:observer_cli` resolves WITHOUT booting a second Grappa.Application; the
# `exec` (not `exec -T`) keeps the TTY the TUI needs. RELEASE_COOKIE and the
# node name are expanded INSIDE the container's `sh -c`, matching
# `bin/grappa remote-shell`.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)" (#364).
#
# Requires the dev image: observer_cli is an `only: [:dev]` dep.

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

exec docker compose "${COMPOSE_ARGS[@]}" exec grappa sh -c \
    'exec iex --sname "obs-$$" --cookie "$RELEASE_COOKIE" -S mix run --no-start --no-compile -e "$1"' \
    -- ':observer_cli.start(:"grappa@grappa")'
