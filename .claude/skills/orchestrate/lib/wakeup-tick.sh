#!/usr/bin/env bash
# orchestrate-tick — one-shot pane sample. Detects sibling state and emits
# zero-or-more event lines to stdout. Designed to be called by daemon.sh
# every TICK_INTERVAL seconds, OR directly for one-shot probes (boot tick,
# debug).
#
# Event vocabulary (extended in v2 — was: BOOT/IDLE/BUSY/CTX-BUMP/HEARTBEAT/
# SAME/PANE-MISSING):
#   BOOT  state=<idle|busy|prompt|picker> ctx=<NN|TBD>%
#   IDLE  ctx=NN%               (busy → idle, no prompt/picker pending)
#   BUSY  ctx=NN%               (idle → busy)
#   PROMPT-PENDING ctx=NN%      (sibling on a permission/dialog prompt — DON'T act)
#   PROMPT-CLEARED ctx=NN%      (prompt resolved — sibling unblocked)
#   PICKER ctx=NN%              (sibling popped a design-Q picker — HALT)
#   PICKER-CLEARED ctx=NN%      (picker resolved)
#   USER-TYPED ctx=NN%          (vjt typed in pane directly — observe only)
#   CTX-BUMP NN% state=<...>    (entered new ≥10%-bucket at ≥30%)
#   CTX-CRITICAL NN% state=<...>(entered ≥80% — last-chance clear)
#   STALL state=<...> ctx=NN% duration=Ns  (same state ≥300s)
#   HEARTBEAT state=<...> ctx=NN%          (no event in ≥600s — down from 1800)
#   SAME state=<...> ctx=NN%    (no transition; daemon swallows, debug shows)
#   PANE-MISSING                (and exits)
#
# State file at /tmp/orchestrate-state-<pane>.json (key=value lines):
#   state                 — idle|busy|prompt|picker
#   ctx                   — NN or TBD
#   bucket                — NN (10s)
#   last_emit             — unix ts
#   last_state_change     — unix ts (for STALL detection)
#   last_user_typed_hash  — md5 of last user-typed line (for dedup)
#   prompt_active         — 0|1
#   picker_active         — 0|1
#
# Busy detector: spinner shape `… (` in last 15 OR explicit interrupt
# prompt (`Press up to edit` / `esc to interrupt`). Bare `…` is NOT busy.
# Idle debounce: 5s re-capture confirms idle (transient tool-call gaps).
#
# Prompt detector: any `Do you want to …?` question AND a `1. Yes` numbered
#   list. It was pinned to the literal `Do you want to proceed?`, which misses
#   every file-scoped variant Claude Code actually asks — `Do you want to make
#   this edit to SKILL.md?`, `…to create <file>?`. Those got classified IDLE,
#   so a blocked worker looked merely quiet (caught on w2/#485, 2026-07-28).
#   The `1. Yes` line is the real invariant of a permission modal; the question
#   wording is not.
# Picker detector: `↑/↓ to navigate` OR `Tab/Arrow keys to navigate` OR
#   `Enter to select` lines.
#
# ctx parse: tries `🧠 NN%`, then `🧠 TBD` (clear-fresh), then nothing → TBD.

set -u
pane="${1:?usage: wakeup-tick.sh <SIBLING_PANE_ID>}"
state_file="/tmp/orchestrate-state-${pane#%}.json"
now=$(date +%s)

# ASK TMUX FOR MORE LINES THAN THE PANE SHOWS (vjt, 2026-08-02).
#
# `capture-pane -p` with no -S returns only the VISIBLE viewport. vjt's panes
# run as short as 11 lines, and a worker rendering a todo list under its
# spinner pushes the spinner line off the top — so the `… (` probe found
# nothing and a WORKING worker was classified IDLE. Caught 2026-08-02 when both
# workers reported `STALL state=idle` while visibly mid-gate. A false IDLE is
# worse than a false BUSY: it makes the orchestrator interrupt someone working.
#
# `-S -30` asks for 30 lines of history, so the spinner, a permission modal and
# a picker all stay in frame regardless of the user's terminal geometry.
# (The pane being too short to show its own spinner is the USER'S geometry —
# report it, never resize his window.)
#
# The cost of including scrollback is the mirror risk: a spinner left in
# history could read as busy forever. `spinner_is_live` below settles that.
out=$(tmux capture-pane -t "$pane" -p -S -30 2>/dev/null)
if [ -z "$out" ]; then
  echo "PANE-MISSING"
  exit 0
fi

tail=$(echo "$out" | tail -30)

# --- Detect sub-state: prompt > picker > busy > idle ---
prompt_active=0
picker_active=0
state="idle"

if echo "$tail" | grep -qE 'Do you want to .*\?' \
   && echo "$tail" | grep -qE '^[[:space:]]*[❯>]?[[:space:]]*1\.[[:space:]]+Yes'; then
  prompt_active=1
  state="prompt"
elif echo "$tail" | grep -qE '↑/↓ to navigate|Tab/Arrow keys to navigate|Enter to select'; then
  picker_active=1
  state="picker"
elif echo "$tail" | awk '/… \(/{f=1} END{exit !f}' \
     || echo "$tail" | grep -qE 'Press up to edit|esc to interrupt'; then
  state="busy"
else
  state="idle"
fi

# --- ctx parse with fallback ---
ctx=$(echo "$out" | grep -oE "🧠 [0-9]+%" | tail -1 | grep -oE "[0-9]+")
if [ -z "$ctx" ]; then
  if echo "$out" | grep -qE "🧠 TBD"; then
    ctx="TBD"
  else
    ctx="TBD"
  fi
fi
bucket=""
if [ "$ctx" != "TBD" ]; then
  bucket=$(( (ctx / 10) * 10 ))
fi

# --- Read prior state ---
prev_state=""
prev_bucket=""
prev_prompt=0
prev_picker=0
prev_user_hash=""
last_emit="$now"
last_state_change="$now"
if [ -f "$state_file" ]; then
  while IFS='=' read -r k v; do
    case "$k" in
      state)                prev_state="$v" ;;
      bucket)               prev_bucket="$v" ;;
      prompt_active)        prev_prompt="$v" ;;
      picker_active)        prev_picker="$v" ;;
      last_user_typed_hash) prev_user_hash="$v" ;;
      last_emit)            last_emit="$v" ;;
      last_state_change)    last_state_change="$v" ;;
    esac
  done < "$state_file"
fi

# --- Is that spinner ALIVE, or just sitting in scrollback? ---
#
# Now that the capture includes history (-S -30), a `… (` match no longer
# proves a turn is running: a spinner frame left in scrollback would pin the
# worker to BUSY forever, which is how an orchestrator stops noticing a worker
# that has been waiting on it.
#
# A live spinner ANIMATES; a dead one does not. Read its timer twice, 5s apart:
# advanced ⇒ the turn is live; frozen ⇒ scrollback, treat as idle. This is
# geometry-independent and cannot be fooled either way.
#
# Only the `… (` path needs this. `esc to interrupt` / `Press up to edit` are
# rendered by the live input frame, never left behind in history.
# Grab the WHOLE parenthesised timer up to the first `·` or `)`, rather than
# enumerating time formats. The old pattern (`[0-9]+m? ?[0-9]*s`) could not
# parse an hours component, so `… (1h 1m 57s` matched NOTHING, `t2` came back
# empty, and the `-z "$t2"` branch below forced state=idle — pinning any turn
# older than an hour to a permanent false IDLE. Confirmed by execution on w2
# 2026-08-03. Format-agnostic beats an enumeration that a UI change can outrun.
spinner_timer() {
  tmux capture-pane -t "$1" -p -S -30 2>/dev/null \
    | grep -oE '… \([^·)]*' | tail -1
}

# A SECOND LIVENESS WITNESS, because the spinner timer is not always one.
#
# MEASURED on w1 (%16) 2026-08-25 14:54Z, not deduced. That pane renders
# BROKENLY: a capture holds SEVERAL stale spinner frames at once — `… (54m 39s`
# AND `… (54m 42s` in the same `-S -30` — and NEITHER advances. Two calls to
# `spinner_timer` 5s apart both returned `54m 42s` while the turn was plainly
# running: the cost counter moved $9.26 → $9.91 over the same minutes and the
# worktree went dirty→clean. The freeze guard below therefore read a LIVE turn
# as scrollback and demoted it to idle — and because the next tick saw a
# different frozen value it flipped back, producing the perfect BUSY/IDLE
# alternation in `/tmp/orchestrate-events-16.log`: ~20 pairs, ctx climbing
# monotonically through every one of them, plus `STALL state=idle` at 306s.
# The orchestrator burned one hand probe per event and nearly learned to
# ignore the pane, which is how a REAL idle gets missed.
#
# The cost line lives in the status block, which that pane DOES redraw. It is
# also a strictly safer witness in the direction that matters: cost only moves
# while a turn is generating, so it cannot resurrect the pinned-BUSY bug this
# freeze guard was written to kill (measured on w2 2026-08-18) — on a genuinely
# idle worker `$c1 = $c2` and the demotion still fires. The cost is therefore a
# RESCUE only: it can keep busy, never impose it.
turn_cost() {
  tmux capture-pane -t "$1" -p -S -30 2>/dev/null \
    | grep -oE '💰 \$[0-9]+\.[0-9]+' | tail -1
}

# `frozen_spinner` carries the freeze verdict FORWARD to the idle debounce below.
# Without it the debounce re-reads the same scrollback and undoes this decision —
# see the comment on the debounce for the measurement.
frozen_spinner=""

if [ "$state" = "busy" ] \
   && ! echo "$tail" | grep -qE 'Press up to edit|esc to interrupt'; then
  t1=$(spinner_timer "$pane"); c1=$(turn_cost "$pane")
  sleep 5
  t2=$(spinner_timer "$pane"); c2=$(turn_cost "$pane")
  # Frozen or vanished ⇒ not a running turn — UNLESS the cost says otherwise.
  if [ -z "$t2" ] || [ "$t1" = "$t2" ]; then
    if [ -n "$c1" ] && [ -n "$c2" ] && [ "$c1" != "$c2" ]; then
      : # cost advanced ⇒ a turn IS generating; the spinner line is just stale
    else
      state="idle"
      frozen_spinner="$t2"
    fi
  fi
fi

# --- Idle debounce (only on busy → idle) ---
if [ "$state" = "idle" ] && [ "$prev_state" = "busy" ]; then
  sleep 5
  # -S -30, NOT the bare viewport: vjt's worker panes are 63x9, so the visible
  # nine rows hold only the input frame + status line and can never contain the
  # `… (` shape. Re-reading the viewport alone made this debounce incapable of
  # ever restoring `busy` — the same geometry lesson the main capture above
  # already learned, left unapplied here.
  out2=$(tmux capture-pane -t "$pane" -p -S -30 2>/dev/null)
  tail2=$(echo "$out2" | tail -30)
  if echo "$tail2" | grep -qE 'Do you want to .*\?'; then
    state="prompt"
    prompt_active=1
  elif echo "$tail2" | grep -qE '↑/↓ to navigate|Tab/Arrow keys to navigate|Enter to select'; then
    state="picker"
    picker_active=1
  elif echo "$tail2" | grep -qE 'Press up to edit|esc to interrupt'; then
    state="busy"
  elif echo "$tail2" | awk '/… \(/{f=1} END{exit !f}'; then
    # A bare `… (` here is NOT proof of a running turn: `-S -30` reaches into
    # scrollback, and a spinner left in history matches forever. MEASURED on w2
    # 2026-08-18 00:23Z — the main detector said busy, the freeze guard above
    # correctly demoted it to idle, and THIS branch resurrected busy from the
    # same frozen line. Because `prev_state` was then busy, the debounce ran
    # again on the next tick and every tick after: w2 was pinned to a false BUSY
    # for ~25 minutes while sitting idle, and the orchestrator would have missed
    # its reply. A fresh state file classified the same pane `idle`, which is how
    # the prior state — not the pane — was identified as the discriminator.
    # So: only believe a spinner the freeze test has NOT already declared frozen.
    t3=$(spinner_timer "$pane")
    if [ -n "$t3" ] && [ "$t3" != "$frozen_spinner" ]; then
      state="busy"
    fi
  fi
fi

# --- USER-TYPED detection ---
# Find the last `❯ <text>` line that isn't part of the input prompt frame.
# The pane's empty input is rendered as `❯ ` (no trailing text). Anything
# else is either user input echo (recent submission) or a queued message.
last_user_line=$(echo "$out" | grep -E '^❯ .+' | tail -1 | sed 's/^❯ //')
user_hash=""
user_typed_event=""
if [ -n "$last_user_line" ]; then
  user_hash=$(echo -n "$last_user_line" | md5)
  if [ "$user_hash" != "$prev_user_hash" ] && [ -n "$prev_user_hash" ]; then
    user_typed_event="USER-TYPED ctx=${ctx}%"
  fi
fi

# --- Compute primary event ---
event=""
if [ -z "$prev_state" ]; then
  event="BOOT state=${state} ctx=${ctx}%"
elif [ "$state" != "$prev_state" ]; then
  case "$state" in
    idle)
      # Where did we come from?
      if [ "$prev_state" = "prompt" ]; then
        event="PROMPT-CLEARED ctx=${ctx}%"
      elif [ "$prev_state" = "picker" ]; then
        event="PICKER-CLEARED ctx=${ctx}%"
      else
        event="IDLE ctx=${ctx}%"
      fi
      ;;
    busy)
      event="BUSY ctx=${ctx}%"
      ;;
    prompt)
      event="PROMPT-PENDING ctx=${ctx}%"
      ;;
    picker)
      event="PICKER ctx=${ctx}%"
      ;;
  esac
fi

# --- ctx-bump events ---
ctx_event=""
if [ -n "$bucket" ] && [ "$bucket" -ge 30 ] && [ "$bucket" != "$prev_bucket" ]; then
  if [ "$bucket" -ge 80 ]; then
    ctx_event="CTX-CRITICAL ${ctx}% state=${state}"
  else
    ctx_event="CTX-BUMP ${ctx}% state=${state}"
  fi
fi

# --- Emit + update state-change tracking ---
emitted=0
if [ -n "$event" ]; then
  echo "$event"
  emitted=1
  last_emit="$now"
  last_state_change="$now"
fi
if [ -n "$ctx_event" ]; then
  echo "$ctx_event"
  emitted=1
  last_emit="$now"
fi
if [ -n "$user_typed_event" ]; then
  echo "$user_typed_event"
  emitted=1
  last_emit="$now"
fi

# --- STALL detection (same state ≥300s) ---
if [ "$emitted" = "0" ] && [ "$state" = "$prev_state" ]; then
  stall=$(( now - last_state_change ))
  if [ "$stall" -ge 300 ]; then
    # Only emit STALL once per 300s window — gate via last_emit.
    if [ $((now - last_emit)) -ge 300 ]; then
      echo "STALL state=${state} ctx=${ctx}% duration=${stall}s"
      emitted=1
      last_emit="$now"
    fi
  fi
fi

# --- Heartbeat (no event in ≥600s — was 1800) ---
if [ "$emitted" = "0" ]; then
  if [ $((now - last_emit)) -ge 600 ]; then
    echo "HEARTBEAT state=${state} ctx=${ctx}%"
    emitted=1
    last_emit="$now"
  else
    echo "SAME state=${state} ctx=${ctx}%"
  fi
fi

# --- Persist new state ---
{
  echo "state=${state}"
  echo "ctx=${ctx}"
  echo "bucket=${bucket}"
  echo "prompt_active=${prompt_active}"
  echo "picker_active=${picker_active}"
  echo "last_user_typed_hash=${user_hash}"
  echo "last_emit=${last_emit}"
  echo "last_state_change=${last_state_change}"
} > "$state_file"
