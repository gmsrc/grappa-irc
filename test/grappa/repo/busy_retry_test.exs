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
end
