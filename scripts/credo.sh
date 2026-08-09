#!/usr/bin/env bash
# Run Credo (strict by default) inside the container.
#
# Usage:
#   scripts/credo.sh           # mix credo --strict
#   scripts/credo.sh suggest   # mix credo suggest --strict (more verbose)
#   scripts/credo.sh list      # mix credo list (one-line per finding)
#   scripts/credo.sh diff main    # show issues only on changed files vs main
#
# Pins MIX_ENV=dev via scripts/mix.sh: credo is `only: [:dev, :test]` and is
# absent from a prod-profile container.

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

if [ $# -eq 0 ]; then
    "$SRC_ROOT/scripts/mix.sh" --env=dev credo --strict
else
    "$SRC_ROOT/scripts/mix.sh" --env=dev credo "$@" --strict
fi
