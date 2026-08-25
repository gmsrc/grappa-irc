defmodule Grappa.WindowCounts.Pusher.Coalescer do
  @moduledoc """
  #1768 — at most ONE `window_counts` snapshot per window per
  `window_ms/0`, however many rows land inside it.

  ## Why the emit and not the wire

  `Grappa.Session.Persistor.dispatch_push/2` fires the #267 push for
  EVERY persisted row, and `Pusher.push/1` used to hand each one straight
  to `Grappa.TaskSupervisor` — one task, and one fresh
  `WindowCounts.snapshot/7`, per row. Measured on prod during the
  2026-08-25 00:15 incident: of 413 queries dropped from the SQLite pool
  in the saturation burst, **412 were badge arithmetic** (304 frames in
  `WindowCounts.count_mentions/6`, 108 in
  `Scrollback.count_after_split/6`). The pool is 10 connections wide
  (`config/runtime.exs`); the snapshot fan-out is bounded by nothing.

  Batching the WIRE would have saved bytes. It would not have helped:
  the tasks are spawned before any framing exists, and what saturated
  the pool was their NUMBER.

  ## The property this buys, stated exactly

  In-flight snapshot work becomes **O(distinct windows touched)** instead
  of **O(rows persisted)**. That is the whole claim, and it is the one
  that maps onto a fixed-size pool: rows per unit time are unbounded (a
  netsplit delivers one presence row per shared channel per peer), while
  windows are bounded by the channels the subject is in.

  It is NOT a claim about the sustained rate. A subject taking 29.5
  events/s spread thinly across many windows coalesces very little,
  because each window is already below one row per window length. The
  lever bites on the BURST, which is what the incident was.

  ## Dropping intermediate emits is lossless BY CONSTRUCTION

  The snapshot is absolute — cic "replaces its stored snapshot verbatim"
  (`Pusher` moduledoc) — and `Pusher.emit/1` computes it from the DB at
  flush time, not at touch time. So a later snapshot supersedes an
  earlier one completely, and the one this module does emit has seen
  every row of the burst. Nothing is deferred that a reader could miss:
  the ROW itself is broadcast by the Persistor immediately and
  independently, ahead of the push. Only the derived count waits.

  ## A fixed window, never extended — the starvation trap

  The timer is armed by the FIRST touch of an idle window and is never
  reset by later ones. That is deliberate and is the difference between
  a throttle and a debounce: a debounce that restarts on every arrival
  emits NOTHING while rows keep arriving faster than the window, and the
  measured presence flood (#1680: 24.4 presence events/s sustained, one
  every ~41 ms) is exactly that regime. A badge that freezes during the
  only period it matters is a worse bug than the one being fixed.

  So the contract is two-sided: **at most one** emit per window per
  `window_ms/0`, and **at least one** within `window_ms/0` of any row
  that arrives — no arrival is ever left unrepresented for longer than
  the window.

  ## Why a GenServer

  State that must persist between calls, serialized by a mailbox —
  the CLAUDE.md GenServer case. The state is a map of the windows with a
  flush armed, keyed by `{subject, network_id, channel}`; presence of the
  key IS the "armed" flag, so no parallel bookkeeping can drift from it
  (design discipline 1). Idle windows hold nothing.

  A crash costs the pending flushes and nothing else: the snapshot is a
  live-render optimization, and the next `join_reply` / `/me` /
  `read_cursor_set` re-seeds the absolute snapshot regardless — the same
  degradation `PushSource` already documents for its `nil` impl. The
  restarted process starts empty and the next row re-arms.

  ## The key is NOT folded

  `{subject, network_id, channel}` takes the channel verbatim, because it
  must partition the same way the BROADCAST TOPIC does
  (`Topic.channel/3`, also verbatim). Folding it here would let one
  casing's flush stand in for another's, and the subscribers of the topic
  that lost the draw would get nothing — a fold that silently merges two
  destinations, which is the opposite of what the #537 key fold is for.
  """

  use GenServer

  alias Grappa.WindowCounts.{Pusher, PushSource}

  @typedoc """
  The window a snapshot is for. `subject` + `network_id` are the DB-side
  identity the snapshot queries on; `channel` is verbatim (see moduledoc).
  """
  @type key :: {Grappa.Subject.t(), integer(), String.t()}

  @typedoc """
  Windows with a flush armed → the newest ctx seen for each. Presence of
  the key is the armed flag.
  """
  @type pending :: %{key() => PushSource.ctx()}

  # 250 ms. Chosen against two ceilings and one floor.
  #
  # Ceiling 1 — perception: this is the lag a sidebar badge takes on
  # after its message is already rendered (the row's own broadcast is not
  # delayed). A quarter second on a peripheral counter is below notice; a
  # full second is not.
  #
  # Ceiling 2 — the at-least-once side of the contract above: a row is
  # never unrepresented for longer than this.
  #
  # Floor — it has to span a real burst. An IRC flood (netsplit QUITs, a
  # rejoin's JOIN storm) arrives at socket speed, sub-millisecond between
  # rows, so anything above a few milliseconds collapses it. The value is
  # therefore set by the ceilings, not the floor.
  @window_ms 250

  @doc """
  The coalescing window, in milliseconds. Public so a test can express its
  waits in terms of the shipped value instead of restating it.
  """
  @spec window_ms() :: unquote(@window_ms)
  def window_ms, do: @window_ms

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  @doc """
  Records that `ctx`'s window has new rows. Arms a flush if the window is
  idle; otherwise folds into the one already armed.

  Asynchronous and non-blocking: this runs on the Session hot path, and a
  `GenServer.cast/2` to a process that is not up is a no-op returning
  `:ok` — the same graceful degradation `PushSource` documents, a skipped
  live-render optimization rather than a crash on the persist path.
  """
  @spec touch(PushSource.ctx()) :: :ok
  def touch(ctx) when is_map(ctx), do: GenServer.cast(__MODULE__, {:touch, ctx})

  @impl GenServer
  @spec init(:ok) :: {:ok, pending()}
  def init(:ok), do: {:ok, %{}}

  @impl GenServer
  def handle_cast({:touch, ctx}, pending), do: {:noreply, arm(pending, key(ctx), ctx)}

  @impl GenServer
  def handle_info({:flush, key}, pending) do
    {ctx, rest} = Map.pop!(pending, key)

    # Detached under `Grappa.TaskSupervisor` for the same reason `push/1`
    # detached it before this module existed: the snapshot's DB work is
    # visible to the operator and a crash in it is a report. The return is
    # discarded, not matched — a supervisor that refuses must skip the
    # optimization, never take this process down with it.
    _ = Task.Supervisor.start_child(Grappa.TaskSupervisor, fn -> Pusher.emit(ctx) end)

    {:noreply, rest}
  end

  # Already armed: fold in. The ctx is REPLACED rather than kept, because
  # `own_nick` can move under the subject mid-burst (a /nick) and the
  # flush must key the mention fold on the newest one.
  @spec arm(pending(), key(), PushSource.ctx()) :: pending()
  defp arm(pending, key, ctx) when is_map_key(pending, key), do: %{pending | key => ctx}

  # Idle window: arm the ONE flush for it. Never extended afterwards —
  # see the moduledoc on why a resetting debounce starves.
  defp arm(pending, key, ctx) do
    _ = Process.send_after(self(), {:flush, key}, @window_ms)

    Map.put(pending, key, ctx)
  end

  @spec key(PushSource.ctx()) :: key()
  defp key(%{subject: subject, network_id: network_id, channel: channel}),
    do: {subject, network_id, channel}
end
