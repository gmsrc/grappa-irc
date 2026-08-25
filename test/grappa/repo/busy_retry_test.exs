defmodule Grappa.Repo.BusyRetryTest do
  @moduledoc """
  #523 / #518 — the shared SQLite busy-retry engine.

  Extracts the retry/classify discipline that shipped inside
  `Grappa.Scrollback.with_pool_retry/1` (#336 / #340) so EVERY write path
  — not just the scrollback hot path — rides out a transient
  `SQLITE_BUSY` instead of letting it escape as a 500.

  The engine's terminal policy is the DELIBERATE point of divergence from
  the scrollback wrapper, and each divergence is asserted below:

    * transient fault, budget exhausted → `{:error, :db_unavailable}`
      (a caller routes this through `FallbackController` to a clean 503 —
      #518). Scrollback maps it to its own `:persist_unavailable` drop.
    * NON-transient fault (syntax / corruption) → **re-raises**. This is a
      real bug the operator/CI must see as a loud 500, NOT be masked as
      transient backpressure (CLAUDE.md "no silent-swallow at
      boundaries"). Scrollback's own wrapper rescues it to keep its
      never-crash-the-session #336 contract — but the ENGINE surfaces it.
  """
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias Grappa.Repo.BusyRetry

  # A pool checkout that could not be served — always transient (retry).
  defp raise_queue_timeout do
    raise %DBConnection.ConnectionError{message: "queue timeout", reason: :queue_timeout}
  end

  # A >busy_timeout write-lock contention — transient (retry). The message
  # text is the only discriminator SQLite gives us for busy/locked.
  defp raise_busy do
    raise %Exqlite.Error{message: "database is locked", statement: nil}
  end

  # Syntax / corruption — NON-transient: retrying only spins.
  defp raise_syntax do
    raise %Exqlite.Error{message: "near \"SLECT\": syntax error", statement: nil}
  end

  # #1657 — the pool cancelling its own victim's statement at the checkout
  # deadline. Transient by construction; see the describe block below.
  defp raise_interrupted do
    raise %Exqlite.Error{message: "interrupted", statement: nil}
  end

  # #1708 — the pool closing the connection AFTER the statement completed.
  # Built through Ecto's OWN constructor, never a hand-typed sentence: the
  # empty-count rendering IS the discriminator, so a test that spelled the
  # message itself would keep passing after Ecto reworded it. See the describe
  # block below.
  defp orphaned_write_error do
    Ecto.MultiplePrimaryKeyError.exception(
      operation: :insert,
      source: "messages",
      params: [1, "#bofh", "hello"],
      count: nil
    )
  end

  # The reading the exception's own text asserts: more than one row really came
  # back. Unreachable on a single-row `INSERT … VALUES … RETURNING`
  # (`sqlite3_changes()` is 1, or the statement failed) but perfectly reachable
  # on an UPDATE or DELETE whose filter is too loose — a real bug the engine
  # must keep surfacing LOUD.
  defp genuine_multi_row_error do
    Ecto.MultiplePrimaryKeyError.exception(
      operation: :update,
      source: "messages",
      params: [1],
      count: 2
    )
  end

  # Every captured terminal line tagged with this fault kind. The `fault=`
  # metadata is what the prose has to agree with, so it is also what selects
  # the lines to judge.
  defp terminal_lines(log, fault) do
    log
    |> String.split("\n")
    |> Enum.filter(&(&1 =~ "db write unavailable" and &1 =~ "fault=#{fault}"))
  end

  describe "run/1 happy + validation paths" do
    test "an {:ok, _} op passes straight through" do
      assert {:ok, :served} = BusyRetry.run(fn -> {:ok, :served} end)
    end

    test "a plain {:error, changeset} passes through unchanged — validation is NOT retried" do
      cs = %Ecto.Changeset{valid?: false}
      {:ok, counter} = Agent.start_link(fn -> 0 end)

      op = fn ->
        Agent.update(counter, &(&1 + 1))
        {:error, cs}
      end

      assert {:error, ^cs} = BusyRetry.run(op)
      assert Agent.get(counter, & &1) == 1
    end
  end

  describe "run/1 transient contention → retry then succeed" do
    test "a pool queue_timeout that clears within the budget is retried then succeeds" do
      {:ok, counter} = Agent.start_link(fn -> 0 end)

      op = fn ->
        n = Agent.get_and_update(counter, fn n -> {n, n + 1} end)
        if n < 2, do: raise_queue_timeout(), else: {:ok, :served}
      end

      assert {:ok, :served} = BusyRetry.run(op)
      assert Agent.get(counter, & &1) == 3
    end

    test "a busy Exqlite.Error that clears within the budget is retried then succeeds" do
      {:ok, counter} = Agent.start_link(fn -> 0 end)

      op = fn ->
        n = Agent.get_and_update(counter, fn n -> {n, n + 1} end)
        if n < 2, do: raise_busy(), else: {:ok, :served}
      end

      assert {:ok, :served} = BusyRetry.run(op)
      assert Agent.get(counter, & &1) == 3
    end
  end

  describe "run/1 terminal policy (the #518 divergence from Scrollback)" do
    test "a persistently-transient op exhausts the budget → {:error, :db_unavailable} (never raises, never :persist_unavailable)" do
      assert {:error, :db_unavailable} = BusyRetry.run(fn -> raise_busy() end)
    end

    test "a persistent pool queue_timeout also degrades to {:error, :db_unavailable}" do
      assert {:error, :db_unavailable} = BusyRetry.run(fn -> raise_queue_timeout() end)
    end

    test "a NON-transient Exqlite.Error RE-RAISES (real bug → loud, not masked as 503) after exactly one attempt" do
      {:ok, counter} = Agent.start_link(fn -> 0 end)

      op = fn ->
        Agent.update(counter, &(&1 + 1))
        raise_syntax()
      end

      assert_raise Exqlite.Error, ~r/syntax error/, fn -> BusyRetry.run(op) end
      assert Agent.get(counter, & &1) == 1
    end
  end

  describe "SQLITE_INTERRUPT is contention, not corruption (#1657)" do
    # The 2026-08-21 1.3.0 herd lost scrollback rows to
    # `%Exqlite.Error{message: "interrupted"}` on ordinary `INSERT INTO
    # messages`. That string is not a corruption signature — it is what the
    # POOL does to its own victim, traced through the deps in tree:
    #
    #   db_connection/lib/db_connection/connection_pool.ex:190
    #     the checkout deadline fires -> Holder.handle_disconnect(holder, exc)
    #   exqlite/lib/exqlite/connection.ex:230
    #     disconnect/2 -> Sqlite3.cancel(db) -> sqlite3_interrupt()
    #   -> the statement in flight returns SQLITE_INTERRUPT
    #
    # So an interrupt is transient contention BY CONSTRUCTION: the only way
    # to earn one is for the pool to have run out of time. Classifying it
    # non-transient spends none of the retry budget on the one fault the
    # budget exists for, and — because a non-transient re-raises — turns a
    # 503-shaped degrade into a raise: a dropped row in Scrollback (whose
    # #336 rescue catches it), a 500 on a stateless web write, and a crash
    # anywhere unwrapped (`Bootstrap` died exactly this way in the incident).
    #
    # It earns its OWN fault kind rather than borrowing one. #1420 split
    # `observed_state/1` in two precisely because one label was worn by a
    # fault it did not describe, and folding an interrupt into
    # `:busy_locked` would make the terminal line read "SQLite write lock
    # held by another writer" about a fault that never touched the write
    # lock — the same defect, re-introduced. `:queue_timeout` is nearer
    # (the pool IS the cause) but still names the wrong observation: that
    # client's checkout was served, and then revoked.
    test "transient_fault?/1 classifies an interrupt as TRANSIENT" do
      assert BusyRetry.transient_fault?(%Exqlite.Error{message: "interrupted", statement: nil})
    end

    test "an interrupt is RIDDEN OUT — the op that recovers on the third attempt succeeds" do
      {:ok, counter} = Agent.start_link(fn -> 0 end)

      op = fn ->
        n = Agent.get_and_update(counter, fn n -> {n, n + 1} end)
        if n < 2, do: raise_interrupted(), else: {:ok, :served}
      end

      assert {:ok, :served} = BusyRetry.run(op)
      assert Agent.get(counter, & &1) == 3
    end

    test "a persistent interrupt degrades to {:error, :db_unavailable} — it never re-raises" do
      assert {:error, :db_unavailable} = BusyRetry.run(fn -> raise_interrupted() end)
    end

    test "a persistent interrupt is no longer one-and-done BY CLASSIFICATION" do
      {:ok, counter} = Agent.start_link(fn -> 0 end)

      op = fn ->
        Agent.update(counter, &(&1 + 1))
        raise_interrupted()
      end

      assert {:error, :db_unavailable} = BusyRetry.run(op)
      # The discriminator against the old behaviour: a `:permanent`
      # classification re-raises after EXACTLY one attempt, whatever the
      # clock says. Here the loop re-entered, so the single attempt is no
      # longer forced by the VERDICT.
      #
      # ⚠️ What this does NOT claim: that a production interrupt gets
      # retried. This op raises instantly, so the budget is still intact on
      # attempt 2; a real one arrives only after DBConnection's 15_000ms
      # `:timeout` has already blown the 1_500ms budget, so the live regime
      # is one attempt anyway — for a reason of LATENCY, not of verdict
      # (moduledoc, "How far the budget REACHES"). This test pins the
      # verdict; nothing here pins a retry count in prod.
      assert Agent.get(counter, & &1) > 1
    end

    test "the observer sees a distinct :interrupted kind — never :busy_locked" do
      {:ok, observed} = Agent.start_link(fn -> [] end)
      on_contention = fn kind, _, _ -> Agent.update(observed, &[kind | &1]) end

      assert {:error, :db_unavailable} =
               BusyRetry.run(fn -> raise_interrupted() end, on_contention: on_contention)

      kinds = Agent.get(observed, & &1)
      assert kinds != []
      assert Enum.all?(kinds, &(&1 == :interrupted))
    end
  end

  # #1708 — the OTHER half of the same pool-disconnect race #1657 closed.
  #
  # `disconnect/2` does two things in order: `Sqlite3.cancel(db)` and then
  # `Sqlite3.close(db)`. Which one the in-flight statement meets decides which
  # symptom the caller gets, and the two are complementary:
  #
  #   * the cancel lands DURING the step -> SQLITE_INTERRUPT -> the statement
  #     LOST, no row -> `%Exqlite.Error{message: "interrupted"}` -> #1657.
  #   * the close lands AFTER the step completed -> the statement WON and the
  #     row is durable, but the handle the driver then consults for the change
  #     count is gone. `exqlite_changes` answers `{:error, :connection_closed}`,
  #     `maybe_changes/2` turns that into `nil`, and `%Result{num_rows: nil}` is
  #     reported to Ecto as SUCCESS. `Ecto.Adapters.SQL.struct/10` has no clause
  #     for it and falls through to `num_rows > 1`, which `nil` satisfies (term
  #     order: every number sorts before every atom), so it raises
  #     `Ecto.MultiplePrimaryKeyError` about a primary key that is not the
  #     problem. Its `count: nil` renders as NOTHING — the `got  entries` with a
  #     double space that prod printed 22 times on 2026-08-22.
  #
  # `Ecto.MultiplePrimaryKeyError` is in NEITHER rescue list on the persistence
  # path (`loop/4` here, `Scrollback.with_pool_retry/1` above it), so it
  # propagated out of `Session.Persistor.persist_and_broadcast/3` and killed 22
  # live IRC sessions — several of them 19 hours old — for a scrollback row
  # that had already landed. The driver-level halves of that chain are measured
  # in `Grappa.Repo.BusyRetryFidelityTest`; this block pins the verdict.
  #
  # It earns its OWN kind for the #1420 reason, and here the borrowing would be
  # worse than a mislabel: `:interrupted` says the statement was cancelled, and
  # this statement COMPLETED. It is also the first NON-RETRYABLE transient —
  # the row is durable, so a retry does not re-attempt a lost write, it inserts
  # a second one.
  describe "a connection closed after the write completed (#1708)" do
    test "the empty count is what prod printed — Ecto renders `got  entries` for count: nil" do
      assert orphaned_write_error().message =~ "but got  entries."
    end

    test "classify/1 answers :connection_closed for an EMPTY count" do
      assert BusyRetry.classify(orphaned_write_error()) == :connection_closed
    end

    test "classify/1 keeps a GENUINE multi-row result :permanent — the real PK bug stays loud" do
      assert BusyRetry.classify(genuine_multi_row_error()) == :permanent
    end

    test "a genuine multi-row result still RE-RAISES out of run/1" do
      assert_raise Ecto.MultiplePrimaryKeyError, fn ->
        BusyRetry.run(fn -> raise genuine_multi_row_error() end)
      end
    end

    test "an orphaned write degrades to {:error, :db_unavailable} — it never reaches the caller" do
      assert {:error, :db_unavailable} = BusyRetry.run(fn -> raise orphaned_write_error() end)
    end

    test "an orphaned write is NEVER retried — a retry would insert the row a second time" do
      {:ok, counter} = Agent.start_link(fn -> 0 end)

      op = fn ->
        Agent.update(counter, &(&1 + 1))
        raise orphaned_write_error()
      end

      assert {:error, :db_unavailable} = BusyRetry.run(op)

      # The discriminator against every other transient kind. This op raises
      # instantly, so the 1_500ms budget is untouched and `:busy_locked` /
      # `:interrupted` would both re-enter the loop dozens of times here (the
      # #1657 sibling test asserts exactly that, `> 1`). Exactly one attempt
      # means the no-retry decision came from the VERDICT, not from the clock.
      assert Agent.get(counter, & &1) == 1
    end

    test "the observer sees a distinct :connection_closed kind, once, flagged terminal" do
      {:ok, observed} = Agent.start_link(fn -> [] end)
      on_contention = fn kind, attempt, terminal? -> Agent.update(observed, &[{kind, attempt, terminal?} | &1]) end

      assert {:error, :db_unavailable} =
               BusyRetry.run(fn -> raise orphaned_write_error() end, on_contention: on_contention)

      assert Agent.get(observed, &Enum.reverse(&1)) == [{:connection_closed, 1, true}]
    end

    test "the terminal line says the write LANDED — it must not report an unavailable write" do
      log =
        capture_log(fn ->
          assert {:error, :db_unavailable} = BusyRetry.run(fn -> raise orphaned_write_error() end)
        end)

      lines =
        log
        |> String.split("\n")
        |> Enum.filter(&(&1 =~ "fault=connection_closed"))

      assert lines != []
      assert Enum.all?(lines, &(&1 =~ "SQLite connection closed after the write completed"))

      # CLAUDE.md log honesty: the row is durably in the table, so the shared
      # `db write unavailable:` opening of the other three kinds is FALSE here
      # and this kind does not borrow it. An operator reading this line must
      # not go looking for a lost row.
      refute Enum.any?(lines, &(&1 =~ "db write unavailable"))
    end
  end

  # #1420 — CLAUDE.md "Log honesty": the line must describe the state it
  # OBSERVED. This one read `SQLite pool saturated` for BOTH fault kinds while
  # its own `fault:` metadata on the SAME line said which one it was. Measured
  # in CI over three stalled integration runs: 4 terminal observations, all
  # four `fault=busy_locked` and none `fault=queue_timeout` — so every one of
  # them was a write-lock contention wearing a pool label, and the two
  # topologies this whole issue is about stayed conflated in the prose that
  # names them.
  #
  # Asserted over the SET of terminal lines carrying a given `fault=`, never
  # over the whole capture: `capture_log/1` sees Logger output from every
  # concurrently-running async file, and several of them drive this same
  # terminal arm. "Every terminal line tagged X names X" is the invariant, and
  # a leaked line from a sibling file satisfies it too.
  describe "terminal log line — the fault it names is the fault it observed" do
    test "a busy_locked exhaustion names the write LOCK, never the pool" do
      log = capture_log(fn -> assert {:error, :db_unavailable} = BusyRetry.run(&raise_busy/0) end)

      lines = terminal_lines(log, :busy_locked)
      assert lines != []
      assert Enum.all?(lines, &(&1 =~ "SQLite write lock held by another writer"))
      refute Enum.any?(lines, &(&1 =~ "pool saturated"))
    end

    test "a queue_timeout exhaustion still names the POOL, never the lock" do
      log = capture_log(fn -> assert {:error, :db_unavailable} = BusyRetry.run(&raise_queue_timeout/0) end)

      lines = terminal_lines(log, :queue_timeout)
      assert lines != []
      assert Enum.all?(lines, &(&1 =~ "SQLite pool saturated"))
      refute Enum.any?(lines, &(&1 =~ "write lock held"))
    end
  end

  # The #357 telemetry seam. Scrollback delegates to this engine and passes
  # `&Scrollback.Telemetry.contention/3` here — so this callback firing IS the
  # shipped contention counters incrementing. A green suite proves behaviour
  # survived; THIS proves the telemetry was not silently mutilated.
  describe "run/2 :on_contention callback" do
    test "fires once per transient attempt with STRICTLY INCREMENTING attempt, then a terminal (dropped: true) call" do
      {:ok, calls} = Agent.start_link(fn -> [] end)

      on_contention = fn kind, attempt, terminal? ->
        Agent.update(calls, &[{kind, attempt, terminal?} | &1])
      end

      assert {:error, :db_unavailable} =
               BusyRetry.run(fn -> raise_busy() end, on_contention: on_contention)

      events = Agent.get(calls, &Enum.reverse(&1))

      # Terminal call is last and flagged dropped/terminal true.
      assert {:busy_locked, _, true} = List.last(events)

      # Every non-terminal call increments 1, 2, 3, … — the shipped counters
      # keep advancing, one per ridden-out attempt (never a silent stall).
      non_terminal = Enum.filter(events, fn {_, _, terminal?} -> terminal? == false end)
      attempts = Enum.map(non_terminal, fn {_, attempt, _} -> attempt end)
      assert attempts == Enum.to_list(1..length(non_terminal))
      assert non_terminal != []
      assert Enum.all?(events, fn {kind, _, _} -> kind == :busy_locked end)
    end

    test "a queue_timeout tags the callback :queue_timeout" do
      {:ok, calls} = Agent.start_link(fn -> [] end)

      on_contention = fn kind, _, _ -> Agent.update(calls, &[kind | &1]) end

      assert {:error, :db_unavailable} =
               BusyRetry.run(fn -> raise_queue_timeout() end, on_contention: on_contention)

      assert Enum.all?(Agent.get(calls, & &1), &(&1 == :queue_timeout))
    end

    test "a successful op fires the callback ZERO times" do
      {:ok, counter} = Agent.start_link(fn -> 0 end)

      assert {:ok, :served} =
               BusyRetry.run(fn -> {:ok, :served} end,
                 on_contention: fn _, _, _ -> Agent.update(counter, &(&1 + 1)) end
               )

      assert Agent.get(counter, & &1) == 0
    end
  end

  # #594 — cross-process fault arming. The process-dictionary seam
  # (`inject_transient_faults/1`) can only reach work that runs in the
  # CALLER's own process; a fault that must fire inside a Phoenix Channel,
  # a Session.Server, or a sink GenServer needs to be armed against THAT
  # pid. `arm_faults/3` stores the count in a shared ETS table keyed by the
  # exact target pid — the same pid-scoped isolation the process dictionary
  # gives (a sibling async test operates on its OWN spawned pid), just
  # externally addressable. `fire_on: 1` is the immediate case (fire on the
  # next check). These tests pin BOTH halves: the target degrades, and the
  # arming process itself is untouched.
  describe "arm_faults/3 (cross-process seam, #594)" do
    test "degrades a BusyRetry.run in the TARGET pid, leaving the caller's own run untouched" do
      test_pid = self()

      target =
        spawn(fn ->
          receive do
            :go ->
              send(test_pid, {:target_result, BusyRetry.run(fn -> {:ok, :wrote} end)})
          end
        end)

      on_exit(fn -> BusyRetry.disarm_faults(target) end)

      BusyRetry.arm_faults(target, 10_000, fire_on: 1)
      send(target, :go)

      # The armed target rides the budget out and degrades — proving the
      # fault fired in a DIFFERENT process than the one that armed it.
      assert_receive {:target_result, {:error, :db_unavailable}}, 2_000

      # The CALLER (this test process) was never armed, so its own run
      # succeeds — the fault did NOT bleed across the pid boundary.
      assert BusyRetry.run(fn -> {:ok, :wrote} end) == {:ok, :wrote}
    end

    test "disarm_faults/1 clears a target's armed count" do
      test_pid = self()

      target =
        spawn(fn ->
          receive do
            :go ->
              send(test_pid, {:target_result, BusyRetry.run(fn -> {:ok, :wrote} end)})
          end
        end)

      BusyRetry.arm_faults(target, 10_000, fire_on: 1)
      :ok = BusyRetry.disarm_faults(target)

      send(target, :go)

      # With the count cleared, the target's run succeeds immediately.
      assert_receive {:target_result, {:ok, :wrote}}, 2_000
    end
  end

  # #594 — the positional selector. A single per-pid counter cannot say
  # "fault the auto-open, not the persist that precedes it" (both are
  # `BusyRetry.run` in the same Session.Server pid, and the persist succeeds
  # ⟺ the open never faults). `fire_on: k` lets the first k-1 fault-CHECKS in
  # the pid ride through, then fires from the k-th — so a test can skip past
  # the persist's checks and land the fault squarely on the open. A "check" is
  # one `maybe_inject_fault/0` at the top of a `run/1` attempt.
  describe "arm_faults/3 with fire_on: (positional selector, #594)" do
    test "fire_on: k rides out the first k-1 checks, then degrades from the k-th" do
      BusyRetry.arm_faults(self(), 10_000, fire_on: 3)
      on_exit(fn -> BusyRetry.disarm_faults(self()) end)

      # Checks 1 and 2 fall inside the pre-fire window — each run rides
      # through and its op succeeds (one check per run, op succeeds attempt 1).
      assert BusyRetry.run(fn -> {:ok, :wrote} end) == {:ok, :wrote}
      assert BusyRetry.run(fn -> {:ok, :wrote} end) == {:ok, :wrote}

      # The 3rd check is the fire point: this run faults on every attempt for
      # the whole budget and degrades — proving the skip window is exactly 2.
      assert BusyRetry.run(fn -> {:ok, :wrote} end) == {:error, :db_unavailable}
    end
  end
end
