#!/usr/bin/env bash
# Run a mix task inside the grappa container.
#
# Usage:
#   scripts/mix.sh deps.get                    # auto-detect MIX_ENV from container
#   scripts/mix.sh --env=dev credo --strict    # explicit env override
#   scripts/mix.sh --env=prod ecto.migrate     # explicit env override
#   scripts/mix.sh --env=test test             # explicit env override
#
# Auto-detect probes `printenv MIX_ENV` inside the live container, and falls
# back to dev when no container is up. Sibling scripts that depend on dev-only
# deps (credo, dialyzer, format, sobelow) MUST pass `--env=dev` explicitly —
# those deps are absent from a prod image, so auto-detect would crash.
#
# `--env=<env>` is recognised ONLY as the first positional arg; anywhere else
# it is passed through to mix verbatim.

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

env=""
if [[ "${1:-}" =~ ^--env=(dev|prod|test)$ ]]; then
    env="${BASH_REMATCH[1]}"
    shift
fi

if [ -z "$env" ]; then
    env="$(detect_mix_env)"
    if [ -z "$env" ]; then
        # No silent default: an operator who expected prod must see they got dev.
        printf 'scripts/mix.sh: container not running, defaulting MIX_ENV=dev\n' >&2
        env="dev"
    fi
fi

# DATABASE_PATH is read ONLY by config/runtime.exs's prod branch, so only prod
# gets an override: compose.yaml interpolates DATABASE_PATH from the HOST's
# MIX_ENV, so `--env=prod` on a dev host would otherwise migrate/read the DEV
# db (#364). dev/test keep their compile-time config.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
db_env=()
if [ "$env" = "prod" ]; then
    db_env=(DATABASE_PATH="$(db_path_for_env prod)")
fi
in_container_or_oneshot env MIX_ENV="$env" "${db_env[@]}" mix "$@"
