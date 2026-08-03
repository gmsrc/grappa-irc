#!/usr/bin/env bash
# ci-watch.sh <PR> [<PR>...] — stream GitHub PR check-state CHANGES, one block per change.
#
# Designed to be armed ONCE via the Monitor tool (persistent: true) instead of an
# inline `while true` in Bash, which trips a permission prompt on every arming.
#
#   Monitor(command: ".../lib/ci-watch.sh 700 703", persistent: true, timeout_ms: 3600000)
#
# Contract:
#   - Keys off CHANGE, never off a check COUNT: an infra-only PR legitimately has
#     3 checks (`integration` does not trigger), so any `n >= 4` settle-guard hangs
#     forever. A poller keyed on the word `pending` exits instantly on an empty
#     list — which is exactly what a CONFLICTING PR returns.
#   - `gh pr checks` is TAB-separated AND the check name itself contains spaces
#     ("cicchetto + grappa + azzurra-testnet"), so it MUST be split on \t, never on
#     whitespace columns. It has no --json.
#   - An EMPTY check list is reported explicitly as `NO-CHECKS (conflicting?)`, not
#     swallowed: a conflicting PR builds no `refs/pull/N/merge`, so `pull_request`
#     workflows never fire and the silence reads exactly like "not started yet".
#   - Never exits on its own. Stop it with TaskStop.
#
# Env: CI_WATCH_INTERVAL (default 60s), CI_WATCH_REPO (default: cwd's repo).

set -u

[ $# -ge 1 ] || { echo "usage: ci-watch.sh <PR> [<PR>...]" >&2; exit 2; }

INTERVAL="${CI_WATCH_INTERVAL:-60}"
REPO_ARG=()
[ -n "${CI_WATCH_REPO:-}" ] && REPO_ARG=(-R "$CI_WATCH_REPO")

snapshot() {
  local pr out
  for pr in "$@"; do
    out=$(gh pr checks "$pr" "${REPO_ARG[@]}" 2>/dev/null \
          | awk -F'\t' -v p="$pr" 'NF>1 {printf "PR%s: %s = %s\n", p, $1, $2}' \
          | sort)
    if [ -z "$out" ]; then
      # Distinguish "no checks" from a transient gh failure by asking for state.
      local ms
      ms=$(gh pr view "$pr" "${REPO_ARG[@]}" --json mergeStateStatus,state \
           -q '.state + "/" + .mergeStateStatus' 2>/dev/null)
      printf 'PR%s: NO-CHECKS (conflicting?) %s\n' "$pr" "${ms:-unreachable}"
    else
      printf '%s\n' "$out"
    fi
  done
}

prev=""
while true; do
  cur=$(snapshot "$@")
  if [ -n "$cur" ] && [ "$cur" != "$prev" ]; then
    printf -- '--- CI change %s ---\n%s\n' "$(TZ=Europe/Rome date +%H:%M)" "$cur"
    prev="$cur"
  fi
  sleep "$INTERVAL"
done
