#!/usr/bin/env bash
# Open a sqlite3 shell against the active database.
#
# Usage:
#   scripts/db.sh                 # interactive sqlite3 shell
#   scripts/db.sh "SELECT * FROM messages LIMIT 5;"   # one-shot query
#
# Reads MIX_ENV from the running container to pick the right db file (dev when
# there is none). Prod DBs open read-only.

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

env="$(in_container printenv MIX_ENV 2>/dev/null || echo dev)"
# Path shape via the _lib.sh SoT — never hardcode it, or it drifts from
# compose.yaml / scripts/mix.sh (#364).
DB="$(db_path_for_env "$env")"
MODE_ARG=""
if [ "$env" = "prod" ]; then
    MODE_ARG="-readonly"
fi

if [ $# -eq 0 ]; then
    in_container sqlite3 $MODE_ARG "$DB"
else
    in_container sqlite3 $MODE_ARG "$DB" "$*"
fi
