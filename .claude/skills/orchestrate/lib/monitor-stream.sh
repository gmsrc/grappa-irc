#!/usr/bin/env bash
# monitor-stream.sh — stream daemon events from one or more panes as a single
# never-ending line feed, for use as the `command` of the Monitor tool with
# `persistent: true`.
#
# WHY THIS EXISTS (v3, 2026-08-02)
# --------------------------------
# v2's `wait-for-event.sh` was a ONE-SHOT: it exited on the next event, the
# harness fired a completion notification, and the orchestrator had to arm
# another one. That re-arm is a manual step in a loop, and a manual step in a
# loop eventually gets skipped.
#
# It did get skipped — badly. Arming a waiter and a CI poller in the SAME
# assistant message gets BOTH reaped by the harness, so the waiter silently
# never existed. On 2026-08-02 that left the orchestrator with zero listeners
# while BOTH workers sat halted on questions — w2 for ~60 minutes, w1 for ~30 —
# and the orchestrator went on merging PRs reporting them as "building". vjt
# had to notice and say so.
#
# The failure mode is structural, not careless: an absent listener and a quiet
# worker produce EXACTLY the same thing, which is nothing. You cannot notice
# silence.
#
# Monitor + this script removes the loop. One arm at session start, one
# notification per event, forever. Nothing to re-arm, so nothing to forget.
#
# USAGE
#   Monitor({
#     command: ".claude/skills/orchestrate/lib/monitor-stream.sh %16 %28",
#     description: "grappa worker pane events",
#     persistent: true,
#   })
#
# Each pane's events are prefixed with its label so one stream serves N panes.
# Labels come from the tmux pane title when resolvable, else the pane id.
#
# NOTE the daemon must be running for each pane (`daemon.sh start <PANE>`) —
# this only tails what the daemon writes. A dead daemon is silent, and silence
# is indistinguishable from calm, so `daemon.sh status` is still worth a look
# on resume.

set -uo pipefail

if [ $# -eq 0 ]; then
  echo "usage: monitor-stream.sh <PANE_ID> [<PANE_ID>...]" >&2
  exit 2
fi

# Events worth a notification. Deliberately EXCLUDES `BUSY` and
# `STALL state=busy`: a working worker is the common case and would drown the
# useful signal, and Monitor auto-stops a stream that is too chatty.
#
# `IDLE` is the load-bearing one — it is the event whose absence caused the
# 2026-08-02 blindness. `STALL state=idle` is kept because it means the
# ORCHESTRATOR is the bottleneck. `HEARTBEAT` is kept as the "nothing at all is
# happening" backstop, so a wedged-busy worker still eventually surfaces.
FILTER='IDLE|PROMPT|PICKER|USER-TYPED|CTX-|PANE-MISSING|BOOT|HEARTBEAT|STALL state=idle'

pids=()

cleanup() {
  for p in "${pids[@]:-}"; do
    [ -n "${p:-}" ] && kill "$p" 2>/dev/null
  done
}
trap cleanup EXIT INT TERM

for pane in "$@"; do
  id="${pane#%}"
  log="/tmp/orchestrate-events-${id}.log"

  label=$(tmux display-message -p -t "$pane" '#{pane_title}' 2>/dev/null)
  [ -z "$label" ] && label="$pane"

  if [ ! -e "$log" ]; then
    # Announce rather than fail: the daemon may create it a moment later, and
    # -F picks it up. A missing log is worth saying out loud, though — it is
    # the shape a dead daemon takes.
    echo "[$label $pane] NO-EVENT-LOG at $log — is the daemon running?"
  fi

  # -n0: only NEW events, never replay history.
  # -F : survive the log being rotated or created after we start.
  # Every stage flushes per line or events sit in a buffer unseen.
  (
    tail -n0 -F "$log" 2>/dev/null \
      | grep -E --line-buffered "$FILTER" \
      | awk -v pfx="[$label $pane] " '{print pfx $0; fflush()}'
  ) &
  pids+=("$!")
done

wait
