defmodule Grappa.Accounts.Reaper do
  @moduledoc """
  Periodic GC of idle-expired auth `sessions` rows (#223).

  Same shape as `Grappa.Visitors.Reaper` / `Grappa.Uploads.Reaper` — a
  `:permanent` GenServer under the main application supervision tree.
  Default interval is 60s, configurable via the `:interval_ms` start
  opt (the test suite uses a small interval to verify the tick path
  without blocking).

  ## Why a sibling reaper (not folded into Visitors.Reaper)

  Auth sessions are a THIRD domain (Accounts), distinct from visitors
  and uploads. Folding this sweep into `Visitors.Reaper` would make a
  visitor-domain process depend on `Grappa.Accounts` and reap two
  unrelated domains through one tick — the "shared data model" boundary
  violation CLAUDE.md rule 6 warns against. `Uploads.Reaper` already
  exists precisely because uploads are a separate domain; this mirrors
  that precedent. We reuse the VERB (periodic-sweep GenServer +
  bulk set-based query), never the NOUN.

  ## Sweep

  Each tick calls `sweep/0`, which delegates to
  `Accounts.delete_expired_sessions/0` — a single set-based
  `Repo.delete_all` over USER sessions whose `last_seen_at` is older
  than the 7-day idle window (`Accounts.@idle_timeout_seconds`, the
  same constant `authenticate/1` gates on). Visitor sessions are
  deliberately out of scope — they CASCADE from the visitor row via
  `Grappa.Visitors.Reaper`.

  ## It DOES change liveness (#1499)

  This moduledoc used to claim the sweep "only reclaims dead material;
  it changes no liveness semantics", on the reading that a row past the
  window can no longer authenticate so nothing can be resting on it.
  That is true of the ROW and false of the SOCKET, and the distinction
  is the whole of #1499: `GrappaWeb.UserSocket` calls
  `Accounts.authenticate/1` once, at connect, and never again, so a
  client that speaks only over the WebSocket never refreshes
  `last_seen_at` and its row ages out underneath a connection that is
  still serving. `GrappaWeb.SocketLivenessVsSessionRowTest` pins it.

  So the sweep genuinely closes live sockets, and must: leaving one open
  on a row it has just deleted is worse. What it must NOT do is close
  the account's OTHER sockets, which is what a per-subject announcement
  did until #1499 re-keyed it to `Revocations.announce_session/1` — one
  announcement per row swept, addressed at that bearer alone.

  ## No AdminEvent

  Unlike `Visitors.Reaper` (`:visitor_reaped` / `:reaper_swept`) and
  `Uploads.Reaper` (`:upload_reaped` / `:uploads_swept`), this reaper
  emits NO admin event — that enum is a closed, cic-mirrored wire
  contract (`Grappa.AdminEvents.Wire.event_kind`), and session GC
  removes only already-expired tokens with nothing operator-
  actionable to surface. A productive sweep logs once at `:info`
  (`affected: N`) so the lifecycle stays greppable; a zero sweep is
  suppressed to keep the log quiet under the 60s cadence.

  ## Boundary

  `top_level?: true` (mirrors the sibling reapers) so the application
  supervisor can list it as a child without dragging the entire
  Accounts public surface into the application's deps.
  """

  use Boundary, top_level?: true, deps: [Grappa.Accounts]

  use GenServer

  alias Grappa.Accounts

  require Logger

  @default_interval_ms 60_000

  @type opts :: [interval_ms: pos_integer(), name: GenServer.name()]

  defstruct [:interval_ms]

  @type t :: %__MODULE__{interval_ms: pos_integer()}

  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(opts) do
    {name, opts} = Keyword.pop(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Synchronous sweep — deletes every idle-expired USER session row.
  Returns `{:ok, count}` with the number of rows removed. Delegates
  the predicate + delete to `Accounts.delete_expired_sessions/0` (the
  Accounts context owns its schema; the reaper is just the cadence).
  """
  @spec sweep() :: {:ok, non_neg_integer()}
  def sweep do
    # #590 — `delete_expired_sessions/0` degrades a sustained SQLITE_BUSY to
    # `{:error, :db_unavailable}` (uniform with every background-writer context
    # fn) rather than letting the raise escape. The reaper's terminal is
    # best-effort DROP (there is no web caller to 503): log the skipped sweep
    # and report `{:ok, 0}` so the tick's `{:ok, _} = sweep()` stays a total
    # match — mirroring the sibling reapers, whose per-row drops likewise leave
    # the count short and carry on. The next tick retries.
    case Accounts.delete_expired_sessions() do
      {:ok, _} = ok ->
        ok

      {:error, :db_unavailable} ->
        Logger.warning("accounts reaper: db unavailable — sweep dropped, retrying next tick")
        {:ok, 0}
    end
  end

  @impl GenServer
  def init(opts) do
    interval = Keyword.get(opts, :interval_ms, @default_interval_ms)
    schedule_tick(interval)
    {:ok, %__MODULE__{interval_ms: interval}}
  end

  @impl GenServer
  def handle_info(:tick, state) do
    # Schedule the next tick BEFORE running the sweep so the cadence is
    # interval-fixed, not "interval + sweep_duration" (same rationale as
    # Visitors.Reaper REV-J M9). A bulk delete_all is cheap, but keeping
    # the shape identical across the three reapers avoids surprise.
    schedule_tick(state.interval_ms)

    # `delete_expired_sessions/0` logs productive sweeps (count > 0) and
    # deliberately suppresses count=0 to avoid 1440 idle lines/day under
    # the 60s cadence. The reaper stays quiet here so the context
    # function is the single logging site (no double-line). `sweep/0`
    # absorbs a #590 best-effort DROP into `{:ok, 0}` (logged there), so
    # this match stays total even when the pool saturates.
    {:ok, _} = sweep()

    {:noreply, state}
  end

  defp schedule_tick(interval), do: Process.send_after(self(), :tick, interval)
end
