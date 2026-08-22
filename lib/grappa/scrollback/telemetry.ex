defmodule Grappa.Scrollback.Telemetry do
  @moduledoc """
  Telemetry emission for the scrollback write path (#357 Deliverable 1 —
  instrument SQLite write latency BEFORE optimizing it; the fix is a separate,
  design-sensitive deliverable). Same contract shape as
  `Grappa.Admission.Telemetry`: a documented event catalog + typed emit
  helpers a future PromEx exporter subscribes to.

  ## Events

    * `[:grappa, :scrollback, :persist, :start]`
      measurements: `%{monotonic_time, system_time}`
      metadata: `%{channel, kind, network_id, subject, telemetry_span_context}`

    * `[:grappa, :scrollback, :persist, :stop]`
      measurements: `%{duration, monotonic_time}`
      metadata: start-metadata + `%{outcome: :ok | :validation_error | :unavailable}`

      The STOP half of the `:telemetry.span` wrapping
      `Grappa.Scrollback.persist_event/1`'s insert. `duration` is the
      pure DB-write time — mechanism 3 (index write-amplification grows it as
      the table grows) — and is `channel`-tagged so it correlates against a
      channel's inbound msg/s (proving the RATE, not member-count,
      relationship the issue traced). This is the "pure insert" half of the
      split-span pair; the other half is
      `[:grappa, :session, :send_privmsg, :stop]` (total send round-trip,
      INCLUDING mailbox queue time). The gap between the two is the
      head-of-line blocking (mechanism 1).

    * `[:grappa, :scrollback, :persist, :exception]`
      Standard `:telemetry.span` exception event. NOT expected on the happy
      path: `persist_event/1` degrades pool saturation to an `{:error, _}`
      RETURN, never a raise (#336). A `:persist, :exception` therefore flags a
      genuinely unexpected fault, distinct from the (returned) contention
      drop below.

    * `[:grappa, :scrollback, :persist, :contention]`
      measurements: `%{attempt: pos_integer()}`
      metadata: `%{fault: :queue_timeout | :busy_locked | :interrupted, dropped: boolean()}`

      Emitted from `Grappa.Scrollback.with_pool_retry/1` on each transient
      SQLite write-contention fault — mechanism 2 (single-writer contention):
      `:queue_timeout` (the pool could not serve a checkout), `:busy_locked`
      (a slow writer held the single write-lock past `busy_timeout`), or
      `:interrupted` (#1657 — the pool's checkout deadline cancelled a
      statement it had already served; counted apart because it is the only
      one of the three that says the connection was TAKEN BACK rather than
      never granted).
      `dropped: false` = ridden out (a retry follows); `dropped: true` = the
      wall-clock budget was exhausted and the row was dropped — the telemetry
      companion of the existing "SQLite pool saturated" `Logger.warning`, so a
      dashboard can count contention without grepping logs.

  Phase 5 PromEx exporter (deferred) subscribes to these prefixes via
  `:telemetry.attach_many/4` — no code here changes when it lands.
  """

  @type subject :: :user | :visitor | :unknown
  @type persist_outcome :: :ok | :validation_error | :unavailable

  @type persist_metadata :: %{
          channel: String.t() | nil,
          kind: atom(),
          network_id: integer() | nil,
          subject: subject()
        }

  @doc """
  Wrap `fun` (the insert) in the `[:grappa, :scrollback, :persist, …]`
  span. `fun` returns `{result, %{outcome: persist_outcome()}}`; the raw
  `result` is returned unchanged so `persist_event/1`'s contract is untouched.

  Runs in the CALLER's process (for an OUTBOUND send that is the
  `Session.Server` hot loop), so the only added cost is two `monotonic_time`
  reads plus two handler dispatches — a no-op ETS miss while no handler is
  attached (the production default until the Phase 5 exporter lands). No
  synchronous IO is added to the send path.

  `:telemetry.span/3` does NOT carry the start metadata into the `:stop`
  event, so `fun` must return the FULL tag map (plus `:outcome`) as its
  stop-metadata to keep `:stop` channel-tagged — see `persist_event/1`.
  """
  @spec span_persist(persist_metadata(), (-> {result, map()})) :: result
        when result: var
  def span_persist(metadata, fun) when is_map(metadata) and is_function(fun, 0) do
    :telemetry.span([:grappa, :scrollback, :persist], metadata, fun)
  end

  @doc """
  Emit `[:grappa, :scrollback, :persist, :contention]` for ONE transient
  write-contention fault caught in `with_pool_retry/1`. `attempt` is the
  1-based retry attempt; `dropped` is `true` only on the budget-exhausted
  final attempt (the row is lost), `false` while the loop is still riding it
  out. Fires ONLY on the contention path — already the slow path — so it adds
  zero cost to an uncontended insert.
  """
  @spec contention(:queue_timeout | :busy_locked | :interrupted, pos_integer(), boolean()) :: :ok
  def contention(fault, attempt, dropped)
      when fault in [:queue_timeout, :busy_locked, :interrupted] and is_integer(attempt) and
             attempt > 0 and
             is_boolean(dropped) do
    :telemetry.execute(
      [:grappa, :scrollback, :persist, :contention],
      %{attempt: attempt},
      %{fault: fault, dropped: dropped}
    )
  end
end
