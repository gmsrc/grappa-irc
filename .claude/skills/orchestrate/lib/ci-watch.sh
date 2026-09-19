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
#   - An EMPTY check list is reported explicitly, not swallowed: a conflicting PR
#     builds no `refs/pull/N/merge`, so `pull_request` workflows never fire and the
#     silence reads exactly like "not started yet".
#   - But it reports WHAT IT MEASURED, never WHY. It used to print
#     `NO-CHECKS (conflicting?)` and that parenthesis was a cause it had not
#     measured: on 2026-09-19 it printed exactly that for PRs #2248 and #2251 while
#     a by-hand count found 8 and 9 check-runs, i.e. it asserted an emptiness it
#     had never looked at. So the two cases are now SEPARATE:
#       * `gh pr view` answers  => gh works => the empty list is REAL:
#         `NO-CHECKS state=<state>/<mergeStateStatus>` (read the state yourself;
#         CONFLICTING is the zero-CI trap, CLEAN is the ~30s spin-up window).
#       * `gh pr view` also fails => NOTHING was measured:
#         `UNMEASURED gh-failed` — this is NOT a count of zero, and acting on it
#         (a rebase, a force-push) burns a branch over a network blip.
#   - Never exits on its own. Stop it with TaskStop.
#
# Env: CI_WATCH_INTERVAL (default 60s), CI_WATCH_REPO (default: cwd's repo).

set -u

[ $# -ge 1 ] || { echo "usage: ci-watch.sh <PR> [<PR>...]" >&2; exit 2; }

# 180s, not 60: a PR's e2e runs ~25 min, so per-minute granularity buys nothing and
# every emitted line costs the orchestrator a turn.
# NOTE: pass this as an ARGUMENT (`--interval N`), never as a `VAR=x` prefix — a
# prefixed assignment makes the command stop starting with this script's path, which
# breaks the settings.local.json prefix permission rule and re-prompts every arming.
INTERVAL=180
if [ "${1:-}" = "--interval" ]; then INTERVAL="$2"; shift 2; fi
REPO_ARG=()
[ -n "${CI_WATCH_REPO:-}" ] && REPO_ARG=(-R "$CI_WATCH_REPO")

snapshot() {
  local pr out
  for pr in "$@"; do
    out=$(gh pr checks "$pr" "${REPO_ARG[@]}" 2>/dev/null \
          | awk -F'\t' -v p="$pr" 'NF>1 {printf "PR%s: %s = %s\n", p, $1, $2}' \
          | sort)
    if [ -z "$out" ]; then
      # An empty list and an unreachable gh are DIFFERENT facts. Ask for the PR
      # state: if that answers, gh works and the emptiness is real; if it does not,
      # nothing was measured and we must say so instead of reporting a zero.
      local ms
      ms=$(gh pr view "$pr" "${REPO_ARG[@]}" --json mergeStateStatus,state \
           -q '.state + "/" + .mergeStateStatus' 2>/dev/null)
      if [ -n "$ms" ]; then
        printf 'PR%s: NO-CHECKS state=%s\n' "$pr" "$ms"
      else
        printf 'PR%s: UNMEASURED gh-failed\n' "$pr"
      fi
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
