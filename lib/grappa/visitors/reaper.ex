defmodule Grappa.Visitors.Reaper do
  @moduledoc """
  GenServer that periodically sweeps expired visitor rows out of the
  DB. Runs as a `:permanent` child under the main application
  supervision tree.

  ## Cadence

  Default interval is 60s — configurable via the `:interval_ms`
  start option (the test suite uses small intervals to verify the
  tick path without blocking).

  ## Sweep

  Each tick calls `sweep/0`, which enumerates `Visitors.list_expired/0`
  and invokes `Visitors.delete/1` per row. The DB-level FK ON DELETE
  CASCADE on `messages`, `query_windows`,
  `push_subscriptions`, `user_settings`, `read_cursors`, and the
  visitor's PRIVATE `themes` (every table that carries a `visitor_id`
  FK after the visitor-parity cluster + #299) wipes the dependent rows
  in the same transaction. `accounts_sessions` also CASCADEs — the
  bearer token of an expired visitor dies with the row. The one
  non-CASCADE dependent is a reaped visitor's PUBLISHED themes:
  `Visitors.delete/1` re-homes them to the system user (#299) so gallery
  contributions survive the reap. Per-row failures log + continue — one
  bad row does not stop the sweep.

  `Visitors.list_expired/0` carries an explicit `expires_at IS NOT
  NULL` guard so V7 (NickServ-identified visitors persist forever
  via `expires_at = NULL`) requires no coordinated change here —
  the column was flipped to nullable in
  `20260515111331_visitors_expires_at_nullable`. Reaper sees only
  rows that have OPTED IN to expiry by setting a non-NULL timestamp.

  Sweeps that delete zero rows stay quiet (no log line); a non-zero
  sweep logs once at `:info` so operators can grep visitor lifecycle
  across the deletion boundary.

  ## Incognito fast close (#1770 — item 2 of #363)

  Closing the PWA on an incognito session must read as a `/quit`, not as
  "parked, collected an hour later". `GrappaWeb.GrappaChannel` therefore
  casts `client_closing/1` here when a VISITOR's browser reports its
  document is going away, and this server arms a short grace
  (`:incognito_grace_ms`) before `close_incognito/1` decides.

  It is a fast path over the SAME verb the sweep runs (`reap_one/2`),
  never a second wipe, and it is scoped to exactly what the sweep would
  eventually collect: `Visitors.list_expired/0` excludes registered
  visitors, so a registered incognito row — which the 1h linger would
  never touch — is kept here too. Widening that would not be an
  acceleration of the fallback but a new destruction.

  The linger itself is untouched and remains the authoritative guarantee
  for force-kill, tab crash, and every mobile case where the unload event
  never fires at all.

  ## Boundary

  `top_level?: true` — Reaper opts out of `Grappa.Visitors`'s
  boundary so the application supervisor can list it as a child
  without dragging the entire Visitors public surface into the
  application's deps (see `lib/grappa/application.ex`).
  """

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.AdminEvents,
      Grappa.Networks,
      Grappa.Networks.Credential,
      Grappa.Session,
      Grappa.Subject,
      Grappa.Visitors,
      Grappa.Visitors.Visitor,
      Grappa.WSPresence
    ]

  use GenServer

  alias Grappa.{AdminEvents, Session, Subject, Visitors, WSPresence}
  alias Grappa.AdminEvents.Wire, as: AdminWire
  alias Grappa.Networks.{Credential, Credentials}

  require Logger

  @default_interval_ms 60_000

  # #1770 — how long the incognito fast close waits before it believes the
  # browser. Not a debounce, and not an estimate of "how long a close takes":
  # it is the window in which a RELOAD gets to land its replacement socket.
  #
  # Measured on a standalone chromium + webkit bench (2026-08-25): a reload
  # fires `pagehide` with `persisted === false` — byte-identical to what a
  # genuine close fires — and the new document's socket is up 2-3 ms later. So
  # the client's own signal cannot discriminate the two, and this window is
  # what does: at the far end of it, "does this visitor still have a socket"
  # answers the question the event could not.
  #
  # 30s, not a value fitted to that 3 ms, because the two errors are not
  # symmetric. Too short wipes a session its holder is still using, and the
  # wipe is irreversible; too long merely delays a QUIT that would otherwise
  # have waited out the full 1h linger. A real cic reload is a bundle fetch +
  # boot + auth + connect, and that has NOT been measured on a cold cache or a
  # slow mobile link — this number comes from the asymmetry, not from a
  # distribution.
  @default_incognito_grace_ms 30_000

  # The upstream QUIT reason per door. Each names what was OBSERVED: the TTL
  # elapsing and the client going away are different facts, and a channel peer
  # reads this line.
  @expired_reason "visitor session expired"
  @client_closed_reason "session closed"

  @type opts :: [
          interval_ms: pos_integer(),
          incognito_grace_ms: non_neg_integer(),
          name: GenServer.name()
        ]

  defstruct [:interval_ms, :incognito_grace_ms]

  @type t :: %__MODULE__{interval_ms: pos_integer(), incognito_grace_ms: non_neg_integer()}

  @typedoc """
  What `close_incognito/1` OBSERVED. Every value names a state the fast path
  found, never "what it did" — a skipped fast path that logs the absence of
  work instead of the state it saw is the lie CLAUDE.md's log-honesty rule is
  about.
  """
  @type close_outcome :: :closed | :gone | :not_incognito | :registered | :reconnected | :failed

  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(opts) do
    {name, opts} = Keyword.pop(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Synchronous sweep — enumerates expired visitors, stops each visitor's
  live `Session.Server` when its network still exists, then deletes the
  row. Returns `{:ok, count}` with the number of rows successfully
  deleted. Per-row stop/delete failures log + continue; the
  operator-facing failure surface is the `Logger.error` line, not the
  return value.
  """
  @spec sweep() :: {:ok, non_neg_integer()}
  def sweep do
    reconcile_incognito_lingers()
    expired = Visitors.list_expired()

    deleted =
      Enum.reduce(expired, 0, fn v, acc ->
        case reap_one(v, @expired_reason) do
          :ok ->
            acc + 1

          {:error, reason} ->
            Logger.error("reaper delete failed",
              visitor_id: v.id,
              error: inspect(reason)
            )

            acc
        end
      end)

    {:ok, deleted}
  end

  @doc """
  #1770 — arm the incognito fast close for `visitor_id`.

  The browser reported its document is going away (`client_closing` on the
  user channel). That is a HINT and not a teardown: a reload fires the very
  same event, with the same `persisted === false`, and lands a replacement
  socket milliseconds later. So this only starts the grace; what decides is
  `close_incognito/1` at the far end of it, which requires the visitor to
  have NO socket left in `Grappa.WSPresence`.

  Fire-and-forget by construction — the channel process calling this is about
  to die with the tab, and a `GenServer.cast/2` to a Reaper that is not up is
  a no-op returning `:ok` (the posture `WindowCounts.Pusher.Coalescer` states
  for the same reason). Arming twice is harmless and expected: cic registers
  BOTH `pagehide` and `beforeunload`, so two timers fire and the second finds
  the row already gone (`:gone`). That is why there is no pending-set to keep
  — deduplicating would add a structure whose only job is housekeeping for a
  case idempotency already covers.
  """
  @spec client_closing(Ecto.UUID.t()) :: :ok
  def client_closing(visitor_id) when is_binary(visitor_id),
    do: GenServer.cast(__MODULE__, {:client_closing, visitor_id})

  @doc """
  #1770 — the incognito fast close, synchronous (the event-driven sibling of
  `sweep/0`, which is why it is public: the timer calls exactly this).

  Returns what it OBSERVED (`t:close_outcome/0`). It wipes only when all three
  hold, and each guard closes a case the client event cannot speak to:

    * the row is still there and carries `incognito` — the flag is a
      fresh-session choice made at provisioning (#363);
    * it holds NO NickServ credential — the same scope
      `Visitors.list_expired/0` sweeps, so the fast path accelerates the
      linger rather than widening it;
    * no socket for this visitor is left in `Grappa.WSPresence` — the reload
      and second-device cases both land here, and both must abstain.

  The wipe itself is `reap_one/2`, the sweep's own verb: stop every attached
  network's `Session.Server` (the `/quit` the contract promises) and then
  delete the row, whose FK CASCADE takes the dependents.
  """
  @spec close_incognito(Ecto.UUID.t()) :: close_outcome()
  def close_incognito(visitor_id) when is_binary(visitor_id) do
    case Visitors.get(visitor_id) do
      nil -> :gone
      %Visitors.Visitor{incognito: false} -> :not_incognito
      %Visitors.Visitor{incognito: true} = visitor -> close_live_incognito(visitor)
    end
  end

  @spec close_live_incognito(Visitors.Visitor.t()) :: close_outcome()
  defp close_live_incognito(%Visitors.Visitor{id: id} = visitor) do
    cond do
      Credentials.visitor_registered?(id) ->
        Logger.debug("incognito close: holds a NickServ credential — row kept",
          visitor_id: id
        )

        :registered

      WSPresence.ws_count(Subject.label({:visitor, id})) > 0 ->
        Logger.info("incognito close: a browser socket is still connected — row kept",
          visitor_id: id
        )

        :reconnected

      true ->
        wipe_closed_incognito(visitor)
    end
  end

  @spec wipe_closed_incognito(Visitors.Visitor.t()) :: :closed | :failed
  defp wipe_closed_incognito(%Visitors.Visitor{id: id} = visitor) do
    case reap_one(visitor, @client_closed_reason) do
      :ok ->
        Logger.info("incognito close: no browser socket left — session quit, row wiped",
          visitor_id: id
        )

        :closed

      {:error, reason} ->
        Logger.error("incognito close failed", visitor_id: id, error: inspect(reason))
        :failed
    end
  end

  # #363 — before enumerating expiries, refresh the linger TTL of every
  # incognito visitor that still holds a live browser socket. `WSPresence` is
  # the authoritative "a browser is connected" signal (the visitor
  # `Session.Server` outlives the socket, so process liveness is NOT the
  # signal): its `user_name` set carries one subject label per connected
  # subject. Decode each via `Grappa.Subject.from_label/1` — the #413 SSOT
  # for the `"user → user.name, visitor → "visitor:" <> id"` routing codec —
  # rather than re-stating the `"visitor:"` prefix here (a hand-rolled decode
  # would silently fork from the codec if the label scheme ever changes). The
  # generator pattern keeps only `{:visitor, id}` labels; account names decode
  # to `{:user, name}` and drop out. Sliding these forward BEFORE
  # `list_expired/0` reads keeps a connected incognito visitor out of the
  # sweep; a disconnected one is left to elapse and is collected below.
  # Non-incognito ids in the set are a no-op inside
  # `slide_incognito_lingers/1`.
  @spec reconcile_incognito_lingers() :: :ok
  defp reconcile_incognito_lingers do
    connected_visitor_ids =
      for label <- WSPresence.list_user_names(),
          {:visitor, id} <- [Subject.from_label(label)],
          do: id

    _ = Visitors.slide_incognito_lingers(connected_visitor_ids)
    :ok
  end

  # Representative (identity-anchor) nick for the reap event label, read
  # before the delete cascades the credentials away.
  @spec reaped_nick(Visitors.Visitor.t()) :: String.t() | nil
  defp reaped_nick(%Visitors.Visitor{id: id}),
    do: Credentials.representative_visitor_nick(id)

  # The one teardown-then-wipe verb, shared by the periodic sweep and the
  # #1770 fast close so the two doors cannot drift: stop every attached
  # network's session with the reason the CALLER observed, delete the row, and
  # emit the reap event only once both landed.
  #
  # #590 — `Visitors.delete/1` can now degrade a sustained SQLITE_BUSY to
  # `{:error, :db_unavailable}`; each caller's `{:error, reason}` arm logs
  # + continues (best-effort DROP — the row is left for the next tick), so the
  # reaper rides transient contention rather than crashing.
  @spec reap_one(Visitors.Visitor.t(), String.t()) ::
          :ok | {:error, :not_found | :db_unavailable}
  defp reap_one(v, quit_reason) do
    # #211 phase 7 — capture the representative (anchor) nick BEFORE the
    # delete: the identity nick lives per-network on the credentials, which
    # CASCADE with the visitor row, so it can't be read after.
    reaped_nick = reaped_nick(v)

    with :ok <- stop_visitor_session(v, quit_reason),
         :ok <- Visitors.delete(v.id) do
      # M-11: per-row reap event for the admin events stream. Emitted ONLY on
      # a successful delete — a failed delete logs but doesn't fire a
      # misleading "reaped" signal.
      AdminEvents.record(AdminWire.visitor_reaped(v.id, reaped_nick))
    end
  end

  # #211 phase 7 — a visitor is multi-network; stop EVERY attached network's
  # session before the delete cascades the credential rows. Idempotent per
  # network (`stop_session/3` no-ops without a live pid); empty list (no
  # credentials) → nothing to stop. The retired `visitors.network_slug`
  # scalar only ever resolved the primary session.
  @spec stop_visitor_session(Visitors.Visitor.t(), String.t()) :: :ok
  defp stop_visitor_session(%Visitors.Visitor{id: id}, quit_reason) do
    for %Credential{network_id: network_id} <- Credentials.list_visitor_credentials(id) do
      :ok = Session.stop_session({:visitor, id}, network_id, quit_reason)
    end

    :ok
  end

  @impl GenServer
  def init(opts) do
    interval = Keyword.get(opts, :interval_ms, @default_interval_ms)
    schedule_tick(interval)

    {:ok,
     %__MODULE__{
       interval_ms: interval,
       incognito_grace_ms: Keyword.get(opts, :incognito_grace_ms, @default_incognito_grace_ms)
     }}
  end

  # #1770 — arm, don't act. The grace is read from the state rather than the
  # attribute so a caller that started this server with its own window (the
  # test suite does) is not silently overridden by the default.
  @impl GenServer
  def handle_cast({:client_closing, visitor_id}, state) do
    Process.send_after(self(), {:incognito_close, visitor_id}, state.incognito_grace_ms)
    {:noreply, state}
  end

  @impl GenServer
  def handle_info(:tick, state) do
    # REV-J M9: schedule the next tick BEFORE running the sweep so the
    # cadence is interval-fixed, not "interval + sweep_duration". Pre-fix
    # the schedule call lived after `sweep/0` returned; a slow Cloak
    # decrypt or a backlog of expired rows (each delete CASCADEs across
    # 7 dependent tables) could realistically take seconds, drifting
    # the wall-clock cadence under load. With the scheduling first,
    # sweep duration is consumed within the interval rather than
    # extending it — if a sweep ever exceeds the interval, the next
    # `:tick` message piles up in the mailbox and runs back-to-back,
    # which is the right shape ("never less frequent than configured").
    schedule_tick(state.interval_ms)
    {:ok, n} = sweep()

    # M-11: scheduled-tick :reaper_swept summary — actor is nil
    # because the scheduler is "the system", not an operator.
    # Suppressed on count=0 to avoid flooding the admin events
    # ring buffer (200-cap) with 1440 idle ticks/day. Operator-
    # triggered sweeps emit unconditionally via Operator.reap_visitors/1
    # because operators care that "I clicked the button and
    # something happened, even if nothing was expired."
    case n do
      0 ->
        :ok

      _ ->
        Logger.info("reaper swept expired visitors", affected: n)
        :ok = AdminEvents.record(AdminWire.reaper_swept(n))
    end

    {:noreply, state}
  end

  # #1770 — the grace has elapsed; `close_incognito/1` re-derives EVERY gate
  # from the DB and from live presence rather than trusting anything captured
  # at arm time. The row may have registered, been deleted, or come back on a
  # new socket in the meantime, and the authoritative answer is the one taken
  # here.
  @impl GenServer
  def handle_info({:incognito_close, visitor_id}, state) do
    _ = close_incognito(visitor_id)
    {:noreply, state}
  end

  defp schedule_tick(interval), do: Process.send_after(self(), :tick, interval)
end
