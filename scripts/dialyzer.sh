#!/usr/bin/env bash
# Run Dialyzer inside the container.
#
# Usage:
#   scripts/dialyzer.sh           # full whole-app type check
#   scripts/dialyzer.sh --plt     # rebuild PLT cache (slow, do once after deps change)
#
# The PLT cache lives in the bind-mounted `priv/plts/` (`mix.exs`
# `plt_local_path` + `plt_core_path`), so it survives container restarts and
# is shared across worktrees.
#
# Pins MIX_ENV=dev via scripts/mix.sh: dialyxir is `only: [:dev, :test]`.

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

"$SRC_ROOT/scripts/mix.sh" --env=dev dialyzer --format short "$@"
