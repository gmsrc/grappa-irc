#!/usr/bin/env bash
# Run the full CI gate locally inside the container.
#
# Usage:
#   scripts/check.sh
#
# Same gates as the `ci` GitHub workflow, in two stages:
#
#   stage 1: the `mix ci.check` alias in mix.exs (the gate list lives there).
#   stage 2 (this script): the cic↔server wire-shape drift gate, then the
#            host-side bats suite.
#
# Pins MIX_ENV=dev via scripts/mix.sh (credo / sobelow / ex_doc are dev-only
# deps). Two sub-steps inside the alias shell out with `cmd env MIX_ENV=test`:
# the test run (so Repo gets the Sandbox pool) and, since #621, doctor.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
#
# Canonical "which test runner do I use?" docs: docs/TESTING.md.

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

"$SRC_ROOT/scripts/mix.sh" --env=dev ci.check
# Do NOT re-add a second `mix doctor` run here — it belongs in the ci.check
# alias, at MIX_ENV=test.
# Why: docs/TESTING.md § "What each script actually runs" (#621).
#
# Drift gate for cicchetto/src/lib/wireTypes.ts — regenerates the file in
# memory and diffs it against the committed copy.
"$SRC_ROOT/scripts/mix.sh" --env=dev grappa.gen_wire_types --check
"$SRC_ROOT/scripts/bats.sh"
