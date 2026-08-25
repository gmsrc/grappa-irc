defmodule Grappa.Repo.BusyRetry do
  @moduledoc """
  Shared SQLite busy-retry engine (#523 / #518).

  SQLite is single-writer at the file level. Under WAL with `pool_size >
  1` a transient write-lock contention (a slow writer held past
  `busy_timeout`) or a pool `queue_timeout` raises — and unless the
  caller rides it out, that transient fault escapes as a **500**. The
  retry/classify discipline shipped inside `Grappa.Scrollback` (#336 /
  #340) for the message hot path ONLY; this module extracts it so EVERY
  write path can wrap its op the same way — "implement once, reuse
  everywhere."

  ## Contract

  `run/1` takes a zero-arity `op` returning `{:ok, term()}` or `{:error,
  Ecto.Changeset.t()}` and returns:

    * `{:ok, term()}` — the op succeeded (possibly after retries).
    * `{:error, Ecto.Changeset.t()}` — a validation failure returned by
      the op. Passed straight through, **never retried** (it is not a
      fault).
    * `{:error, :db_unavailable}` — a TRANSIENT fault
      (`DBConnection.ConnectionError`, a busy-or-locked / INTERRUPTED
      `%Exqlite.Error{}`, or an empty-count `%Ecto.MultiplePrimaryKeyError{}`
      — see `classify/1`) that persisted for the whole retry budget, or
      that is not retryable at all. A web caller routes this through
      `FallbackController` to a clean **503** (#518) instead of a 500 raise.

  A **non-transient** `%Exqlite.Error{}` (syntax / corruption) is NOT
  saturation: retrying only spins. It **re-raises** with its original
  stacktrace — a real bug the operator/CI must see as a loud 500, not one
  masked as transient backpressure (CLAUDE.md "no silent-swallow at
  boundaries"). This is the deliberate divergence from
  `Scrollback.with_pool_retry/1`, whose #336 never-crash-the-session
  contract makes it rescue even this and drop the row; a stateless web
  write has no such contract, so the honest surface is the raise.

  The retry loop runs over a wall-clock BUDGET, sleeping a linear backoff
  capped per attempt, so a normal write caught behind a burst is ridden
  out; only sustained saturation degrades.

  ## TRANSIENT and RETRYABLE are two axes, not one (#1708)

  They coincided for the first three fault kinds and stopped coinciding with
  the fourth. `:connection_closed` is transient by construction — only the
  pool can produce it — but its statement **completed**, so the row is
  already durable and a second attempt does not re-drive a lost write, it
  inserts a duplicate. It therefore degrades on the FIRST attempt, whatever
  the budget says. `retryable?/1` is that second axis, and a new fault kind
  has to answer both questions, not one.

  ## How far the budget REACHES (#1421)

  The budget is a deadline consulted BETWEEN attempts. It cannot preempt an
  attempt that is already running, because this engine does not own the wait —
  so its reach depends on the FAULT'S OWN latency, and the two live topologies
  do not share a regime:

    * a pool `queue_timeout` is dropped by DBConnection near `queue_target`
      (50ms, doubled once, then dropped — see its "Queue config"), well inside
      the budget. This is the topology the budget was dimensioned for:
      `config/config.exs` sizes it against "the ~1s pool-saturation window the
      #336 incident measured".
    * a write-lock `busy_locked` fault raises only once SQLite's
      `busy_timeout` has expired — 30_000ms in every env, 20x the budget. The
      first attempt has therefore already overshot the deadline by the time it
      returns, so the loop makes EXACTLY ONE attempt and the linear backoff
      below never runs.
    * an `:interrupted` fault (#1657) shares that second regime, and saying
      so is the point. It is raised when DBConnection's own `:timeout`
      (15_000ms by default, 10x the budget) cancels the statement, so the
      first attempt has ALREADY overshot by the time it returns and the loop
      makes exactly one attempt here too. 🔴 So do not read #1657's
      reclassification as "the row now gets retried" — in the live topology
      it does not. What changed is that a pool-induced cancellation stops
      being reported as CORRUPTION: it degrades to `{:error, :db_unavailable}`
      (a 503 on a stateless web write, an honest drop in `Scrollback`)
      instead of re-raising as a 500, and it is countable as its own state.
      Making the budget actually REACH this regime is the same
      re-dimensioning question #1421 prices, and it is not this module's to
      take unilaterally.

  A third topology WOULD fall inside the budget — a deferred read->write
  upgrade raises an immediate `SQLITE_BUSY` that `busy_timeout` does not cover
  — but it cannot occur here: every write transaction goes through
  `Grappa.Repo.immediate_transaction/1`, statically enforced by
  `Grappa.Repo.TransactionModeGateTest` (#1374).

  The second regime is a DOCUMENTED LIMITATION rather than a wiring slip: one
  number was dimensioned for one topology and later reused for another.
  Re-dimensioning it changes retry behaviour under contention — #1420's
  contested axis, and not this module's decision to take. What IS this
  module's to take is to stop describing a bound it does not have, which is
  why the terminal line below reports the wait it OBSERVED and never the
  budget it was handed. Measured in
  `Grappa.Repo.BusyRetryBudgetReachTest`; the options are priced in #1421.
  """

  require Logger

  @budget_ms Application.compile_env(:grappa, [:busy_retry, :budget_ms], 1_500)
  @backoff_ms Application.compile_env(:grappa, [:busy_retry, :backoff_ms], 25)
  @backoff_cap_ms Application.compile_env(:grappa, [:busy_retry, :backoff_cap_ms], 200)

  @type fault_kind :: :queue_timeout | :busy_locked | :interrupted | :connection_closed

  @typedoc """
  Per-contention observer. Called once per RIDDEN-OUT transient attempt with
  `terminal?: false` (attempt strictly increments 1, 2, …) and once on
  budget-exhaustion with `terminal?: true`. `Grappa.Scrollback` passes
  `&Scrollback.Telemetry.contention/3` here, so its #357 contention counters
  are driven straight off this hook (one engine, no forked emitter).
  """
  @type on_contention :: (fault_kind(), pos_integer(), boolean() -> any())

  @doc """
  Runs `op` with bounded retry over transient SQLite write contention.
  See the moduledoc for the full contract.
  """
  @spec run((-> {:ok, result} | {:error, error})) ::
          {:ok, result} | {:error, error | :db_unavailable}
        when result: var, error: var
  def run(op) when is_function(op, 0), do: run(op, [])

  @doc """
  As `run/1`, with `opts`:

    * `:on_contention` — an `t:on_contention/0` observer (see the type).
  """
  @spec run((-> {:ok, result} | {:error, error}), keyword()) ::
          {:ok, result} | {:error, error | :db_unavailable}
        when result: var, error: var
  def run(op, opts) when is_function(op, 0) and is_list(opts) do
    # `started` rather than a precomputed deadline: the terminal line has to
    # report the wall-clock it OBSERVED, and a deadline cannot say how far
    # past itself the run went (#1421).
    loop(op, opts, System.monotonic_time(:millisecond), 1)
  end

  @spec loop((-> {:ok, result} | {:error, error}), keyword(), integer(), pos_integer()) ::
          {:ok, result} | {:error, error | :db_unavailable}
        when result: var, error: var
  defp loop(op, opts, started, attempt) do
    maybe_inject_fault()
    op.()
  rescue
    error in [DBConnection.ConnectionError, Exqlite.Error, Ecto.MultiplePrimaryKeyError] ->
      elapsed_ms = System.monotonic_time(:millisecond) - started

      cond do
        not transient_fault?(error) ->
          # Syntax / corruption — retrying spins pointlessly. Re-raise with
          # the original stacktrace so it surfaces as a loud 500, not a 503.
          reraise error, __STACKTRACE__

        # Identical to the pre-#1421 `monotonic_time < started + @budget_ms`,
        # rearranged so the same subtraction feeds the terminal line. Same
        # arm, same boundary, no timing change. #1708 adds the `retryable?/1`
        # conjunct in FRONT of it, not inside it: a fault whose write already
        # landed must skip this arm on attempt 1 regardless of the clock, and
        # folding that into the budget comparison would make it look like a
        # timing accident rather than a verdict.
        retryable?(error) and elapsed_ms < @budget_ms ->
          on_contention(opts, fault_kind(error), attempt, false)
          # The backoff sleep runs after the failed checkout was already
          # released, so it holds no connection — bounded backpressure on the
          # flooding caller, not a held-conn leak (#340).
          Process.sleep(min(@backoff_ms * attempt, @backoff_cap_ms))
          loop(op, opts, started, attempt + 1)

        true ->
          kind = fault_kind(error)
          on_contention(opts, kind, attempt, true)
          Logger.warning(terminal_message(kind, elapsed_ms, attempt), fault: kind)
          {:error, :db_unavailable}
      end
  end

  # CLAUDE.md "Log honesty": the line describes the state it OBSERVED, not a
  # plausible one. It used to say "SQLite pool saturated" for BOTH fault kinds
  # while its own `fault:` metadata on the same line said which — and #1420
  # measured 4 terminal observations across three stalled CI runs, all four
  # `fault=busy_locked` and none `queue_timeout`. Every one was a write-lock
  # contention wearing a pool label, which is a plausible reason the two
  # topologies stayed conflated for as long as they did.
  #
  # Prose only: same retry, same `{:error, :db_unavailable}`, same metadata.
  # Splitting it also lets the #1429 census count the two apart
  # (`saturated` / `lockheld` in `scripts/log-gap-scan.awk`).
  #
  # #1657 adds the third. Its phrase names what the victim OBSERVED — its
  # statement was cancelled mid-flight — and not the pool deadline that
  # caused it, which this frame never sees and which is already the subject
  # of the timing-out client's own `queue_timeout` line elsewhere in the log.
  #
  # #1708 adds the fourth, and it is the same rule again. It names what this
  # frame OBSERVED — the connection it went to consult was gone — and not the
  # pool deadline that closed it, which this frame never sees. It deliberately
  # does NOT say "cancelled": the statement was not cancelled, it COMPLETED,
  # and that difference is the whole reason the row survives and the retry
  # must not happen.
  @spec observed_state(fault_kind()) :: String.t()
  defp observed_state(:queue_timeout), do: "SQLite pool saturated"
  defp observed_state(:busy_locked), do: "SQLite write lock held by another writer"
  defp observed_state(:interrupted), do: "SQLite statement cancelled by a pool timeout"

  defp observed_state(:connection_closed),
    do: "SQLite connection closed after the write completed"

  # The same rule, applied to the NUMBER on that line (#1421). It used to read
  # "for the full #{@budget_ms}ms retry budget", which is false in the regime
  # that actually occurs: a `busy_locked` fault waits out SQLite's 30_000ms
  # `busy_timeout` inside its FIRST attempt, so the line announced a 1500ms
  # bound for a 30-second wait. The elapsed is the only figure the engine can
  # vouch for; the budget stays on the line as context, not as the bound.
  #
  # 🔴 The #1429 census anchors on this prose, and its bats pins copy it
  # VERBATIM. Both are anchored on the `observed_state/1` phrase ALONE, so this
  # numeric tail can move again without blinding the counters — but a change to
  # the two phrases above still has to move `scripts/log-gap-scan.awk` and
  # `test/scripts/log_gap_scan_test.bats` in the SAME commit. A census whose
  # pattern stopped matching reports zero, and zero is what a clean run looks
  # like.
  #
  # 🔴 `:connection_closed` gets its OWN sentence rather than the shared
  # template, because the template's opening clause is FALSE for it (#1708).
  # "db write unavailable" would send an operator looking for a row that is
  # sitting durably in the table: the statement completed and committed, and
  # what was lost is the RETURNING id and therefore the live broadcast. The
  # "not retried" clause is on the line for the same reason — the attempt
  # count is 1 by verdict here, not because a budget ran out, and a reader
  # comparing it against the other three kinds is entitled to know which.
  @spec terminal_message(fault_kind(), non_neg_integer(), pos_integer()) :: String.t()
  defp terminal_message(:connection_closed, elapsed_ms, attempt) do
    "db write landed but its result was lost: " <>
      "#{observed_state(:connection_closed)}, #{elapsed_ms}ms into the write, " <>
      "on attempt #{attempt} (not retried — the row is durable, a retry would " <>
      "duplicate it) — returning :db_unavailable"
  end

  defp terminal_message(kind, elapsed_ms, attempt) do
    "db write unavailable: #{observed_state(kind)} for #{elapsed_ms}ms across " <>
      "#{attempt} attempts (#{@budget_ms}ms retry budget) — returning :db_unavailable"
  end

  # Invoke the caller's contention observer if one was supplied. Its return is
  # discarded — it is a side-channel (telemetry), not part of the retry result.
  @spec on_contention(keyword(), fault_kind(), pos_integer(), boolean()) :: :ok
  defp on_contention(opts, kind, attempt, terminal?) do
    case Keyword.get(opts, :on_contention) do
      nil -> :ok
      fun when is_function(fun, 3) -> _ = fun.(kind, attempt, terminal?)
    end

    :ok
  end

  @doc """
  Is this caught exception a TRANSIENT write-contention fault (retry) or a
  permanent one (surface at once)? Derived from `classify/1` so there is
  exactly ONE table mapping a driver exception to a verdict. Public so the
  scrollback wrapper reuses the SAME classifier rather than forking one.
  """
  @spec transient_fault?(Exception.t()) :: boolean()
  def transient_fault?(error), do: classify(error) != :permanent

  @doc """
  The single classifier: driver exception → fault kind, or `:permanent`.

  A pool `queue_timeout` is always transient. For an `%Exqlite.Error{}` the
  message text is the only discriminator SQLite gives us, and there are two
  transient shapes, not one:

    * `"interrupted"` — SQLITE_INTERRUPT. **The pool cancelling its own
      victim (#1657).** Traced through the deps: a checkout deadline fires
      (`db_connection/connection_pool.ex:190`) → `Holder.handle_disconnect/2`
      → `Exqlite.Connection.disconnect/2` → `Sqlite3.cancel/1` →
      `sqlite3_interrupt()`, and the statement in flight returns
      SQLITE_INTERRUPT. So an interrupt is contention BY CONSTRUCTION —
      the only way to earn one is for the pool to have run out of time.
      It was classified `:permanent` until #1657, which meant the one
      fault the retry budget exists for spent none of it, and — because a
      permanent fault re-raises — a pool timeout surfaced as a dropped row
      in `Scrollback`, a 500 on a stateless web write, and a crash
      anywhere unwrapped (`Grappa.Bootstrap` died exactly this way on the
      1.3.0 herd).
    * `"busy"` / `"locked"` — a writer held the file lock past
      `busy_timeout`.

  An `%Ecto.MultiplePrimaryKeyError{}` is the third driver symptom, and the
  only one that does not arrive wearing a driver struct (#1708). It is the
  OTHER half of the same pool disconnect: `Exqlite.Connection.disconnect/2`
  runs `Sqlite3.cancel/1` and THEN `Sqlite3.close/1`, and which of the two an
  in-flight statement meets decides the symptom.

    * the cancel lands DURING the step — the statement LOSES, no row, and the
      driver raises `"interrupted"`. That is the arm above.
    * the close lands AFTER the step completed — the statement WON and its row
      is durable, but the handle the driver then consults for the change count
      is gone. `exqlite_changes` answers `{:error, :connection_closed}`,
      `maybe_changes/2` swallows that into `nil`, and — because
      `transaction_status/1` on a closed handle answers `{:ok, :error}` rather
      than an error tuple — the `with` in `execute/4` sails through and reports
      `%Result{num_rows: nil}` to Ecto as SUCCESS. `Ecto.Adapters.SQL.struct/10`
      has clauses for `num_rows: 1` and `num_rows: 0` and then
      `num_rows when num_rows > 1`, which `nil` satisfies (term order puts
      every number before every atom), so it raises about a primary key that
      is not the problem. Measured against the shipped driver in
      `Grappa.Repo.BusyRetryFidelityTest`.

  The discriminator is Ecto's own rendering: it interpolates the count
  straight into the sentence, so `count: nil` prints as NOTHING and leaves the
  `got  entries` double space production logged 22 times on 2026-08-22. An
  EMPTY count is therefore `:connection_closed` (transient, and the one kind
  that is NOT retryable — see `retryable?/1`); a count that is actually there
  means more than one row genuinely came back, which on an UPDATE or DELETE
  with too loose a filter is a real bug, so it stays `:permanent` and re-raises.
  A single-row `INSERT … VALUES … RETURNING` cannot produce the latter at all
  (`sqlite3_changes()` is 1, or the statement failed), which is why the
  scrollback path only ever meets the former.

  Anything else (syntax, corruption) is `:permanent`: retrying only spins.

  🔴 It earns its OWN kind rather than borrowing one. #1420 split
  `observed_state/1` in two precisely because one label was worn by a fault
  it did not describe; folding an interrupt into `:busy_locked` would print
  "write lock held by another writer" about a fault that never touched the
  write lock — the same defect, re-introduced. `:queue_timeout` is nearer
  (the pool IS the cause) but still names the wrong observation: that
  client's checkout was SERVED, and then revoked.
  """
  @spec classify(Exception.t()) :: fault_kind() | :permanent
  def classify(%DBConnection.ConnectionError{}), do: :queue_timeout

  def classify(%Exqlite.Error{message: message}) when is_binary(message) do
    downcased = String.downcase(message)

    cond do
      String.contains?(downcased, "interrupted") -> :interrupted
      String.contains?(downcased, "busy") or String.contains?(downcased, "locked") -> :busy_locked
      true -> :permanent
    end
  end

  def classify(%Exqlite.Error{}), do: :permanent

  def classify(%Ecto.MultiplePrimaryKeyError{message: message}) when is_binary(message) do
    if empty_count?(message), do: :connection_closed, else: :permanent
  end

  # Only the FIRST line is examined. The tail of Ecto's message inspects the
  # bound PARAMS, which on the scrollback path are user-controlled message
  # bodies — a body echoing the sentence must not be able to reclassify a
  # genuine multi-row result as recoverable. `source` is a table name, so the
  # first line cannot itself contain a newline.
  #
  # Pinned by building the error through `Ecto.MultiplePrimaryKeyError`'s OWN
  # constructor in `Grappa.Repo.BusyRetryTest` and
  # `Grappa.Repo.BusyRetryFidelityTest` — never against a hand-typed sentence,
  # so an Ecto release that rewords it fails RED here instead of silently
  # reverting the cure.
  @spec empty_count?(String.t()) :: boolean()
  defp empty_count?(message) do
    message
    |> String.split("\n", parts: 2)
    |> hd()
    |> String.ends_with?("but got  entries.")
  end

  # Is this fault worth a SECOND attempt? Distinct from `transient_fault?/1`
  # (#1708): `:connection_closed` is transient — only the pool can cause it —
  # but its statement already completed, so its write is durable and a retry
  # would insert the row a second time rather than recover a lost one. The
  # other three kinds all mean the write did NOT take effect, so they retry.
  @spec retryable?(Exception.t()) :: boolean()
  defp retryable?(error), do: classify(error) != :connection_closed

  # Only reached after `transient_fault?/1` returned true, so `classify/1`
  # cannot answer `:permanent` here — but the clause is explicit rather than
  # a bare pass-through, so a future transient kind that forgets to teach
  # `observed_state/1` fails LOUD at the case instead of printing a stray atom.
  @spec fault_kind(Exception.t()) :: fault_kind()
  defp fault_kind(error) do
    case classify(error) do
      kind when kind in [:queue_timeout, :busy_locked, :interrupted, :connection_closed] -> kind
    end
  end

  ## ----- Test-only fault injection ------------------------------------
  #
  # The pool_size:1 SQL Sandbox cannot reproduce a real, fast SQLITE_BUSY
  # (busy_timeout 30s, queue_target 5s, a single shared connection = no
  # self-contention), so an end-to-end 503/degrade path (#518) cannot be
  # proven with a genuine fault. This seam lets a test force the next ops in
  # THIS process to raise a transient busy. It is COMPILE-GATED to
  # `Mix.env() == :test`: every other build compiles `maybe_inject_fault/0`
  # to a no-op (dead-code-eliminated), so prod carries no injectable
  # behaviour and pays nothing. Scoped to the calling process's dictionary,
  # so it auto-clears with the test process and cannot leak into a sibling
  # test (unlike a global `:persistent_term`).

  if Mix.env() == :test do
    @fault_pdict_key {__MODULE__, :inject_transient_faults}

    # #594 — cross-process arming lives in a shared ETS table keyed by the
    # TARGET pid. The process-dictionary seam above only reaches work in the
    # caller's own process; a fault that must fire inside a Phoenix Channel,
    # a Session.Server, or a sink GenServer needs to be armed against THAT
    # pid from a test running in a DIFFERENT process. Keyed by the exact
    # target pid, the isolation is identical to the process dictionary's (a
    # concurrent async test operates on its OWN spawned pid and reads `[]`),
    # only externally addressable — so async tests never bleed. The table is
    # created ONCE by the ExUnit runner in `test_helper.exs` (owned by that
    # long-lived process, never created lazily here — that would race
    # `:ets.new` across async tests).
    @fault_ets_table :grappa_busy_retry_cross_process_faults

    @doc false
    @spec inject_transient_faults(non_neg_integer()) :: :ok
    def inject_transient_faults(n) when is_integer(n) and n >= 0 do
      Process.put(@fault_pdict_key, n)
      :ok
    end

    @doc false
    # Arm `n` transient busy faults against `pid`. `fire_on` is 1-indexed and
    # REQUIRED — there is deliberately NO immediate-mode 2-arity: an
    # `arm_faults(pid, n)` whose two args left "WHEN does the fault fire?"
    # implicit is a default argument in disguise, the silent-degradation path
    # CLAUDE.md bans. Making `fire_on:` explicit at every call site is the point
    # (the 40%-doctor-floor artifact #621 is a side effect, not the reason).
    #
    # The fault rides out the first `fire_on - 1` fault-CHECKS in `pid`, then
    # fires from the `fire_on`-th check until `n` is exhausted. A "check" is one
    # `maybe_inject_fault/0` at the top of a `BusyRetry.run/1` attempt — NOT a
    # raw `Repo` call and NOT an operation. `fire_on: 1` fires on the VERY NEXT
    # check (channel / reaper immediate case); a higher value is how #594 pins
    # the query-window auto-open terminal — the persist makes its own wrapped
    # call BEFORE the open, so a single per-pid counter cannot otherwise
    # distinguish "fault the open" from "fault the persist". The exact `fire_on`
    # is DETERMINED EMPIRICALLY per flow (see the #594 session test); a change in
    # how many `BusyRetry.run` calls precede the open is MEANT to break it — and
    # it has: #1657b deleted the persist's `Repo.preload` round-trip, so one
    # check disappeared and that pin moved from `fire_on: 3` to `fire_on: 2`.
    # The break was the contract working, not a regression.
    #
    # Callers MUST `on_exit` a `disarm_faults/1` — a fault left armed on a pid
    # that outlives the test is a failure-at-a-distance (the worst kind to
    # diagnose). Stored as a 3-tuple `{pid, remaining, skip}` where `skip`
    # counts down on each pre-fire check.
    @spec arm_faults(pid(), non_neg_integer(), [{:fire_on, pos_integer()}]) :: :ok
    def arm_faults(pid, n, fire_on: fire_on)
        when is_pid(pid) and is_integer(n) and n >= 0 and is_integer(fire_on) and fire_on >= 1 do
      true = :ets.insert(@fault_ets_table, {pid, n, fire_on - 1})
      :ok
    end

    @doc false
    @spec disarm_faults(pid()) :: :ok
    def disarm_faults(pid) when is_pid(pid) do
      true = :ets.delete(@fault_ets_table, pid)
      :ok
    end

    @doc false
    # Create the cross-process fault table. Called ONCE by `test_helper.exs`
    # from the ExUnit runner process so the `:public` table outlives every
    # test. Idempotent (a re-run finds the table already there).
    @spec ensure_fault_table() :: :ok
    def ensure_fault_table do
      case :ets.whereis(@fault_ets_table) do
        :undefined ->
          :ets.new(@fault_ets_table, [:named_table, :public, :set])
          :ok

        _ ->
          :ok
      end
    end

    # pdict FIRST (the existing in-process seam — every already-green test
    # keeps arming through it, untouched), ETS second (the #594 cross-process
    # seam). Both are pid-scoped, so the order is a pure preference, not a
    # correctness requirement.
    defp maybe_inject_fault do
      cond do
        consume_pdict_fault?() -> raise_injected_busy()
        consume_ets_fault?() -> raise_injected_busy()
        true -> :ok
      end
    end

    @spec consume_pdict_fault?() :: boolean()
    defp consume_pdict_fault? do
      case Process.get(@fault_pdict_key, 0) do
        n when n > 0 ->
          Process.put(@fault_pdict_key, n - 1)
          true

        _ ->
          false
      end
    end

    @spec consume_ets_fault?() :: boolean()
    defp consume_ets_fault? do
      case :ets.lookup(@fault_ets_table, self()) do
        # Still inside the pre-fire window: count this check, let it pass.
        [{pid, n, skip}] when skip > 0 ->
          :ets.insert(@fault_ets_table, {pid, n, skip - 1})
          false

        # Fire window reached and faults remain: consume one and raise.
        [{pid, n, 0}] when n > 0 ->
          :ets.insert(@fault_ets_table, {pid, n - 1, 0})
          true

        _ ->
          false
      end
    end

    # "Database busy" is the VERBATIM message a real write-lock SQLITE_BUSY
    # raises through Ecto (proven by `Grappa.Repo.BusyRetryFidelityTest`, and
    # the #523 prod evidence) — so the injected fault is byte-faithful to
    # reality, not a shape we merely know our own classifier accepts.
    @spec raise_injected_busy() :: no_return()
    defp raise_injected_busy do
      raise %Exqlite.Error{message: "Database busy", statement: nil}
    end
  else
    defp maybe_inject_fault, do: :ok
  end
end
