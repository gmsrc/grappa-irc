defmodule Grappa.Repo.LockWatchReportTest do
  @moduledoc """
  #1420 — what the stall report PRINTS, as opposed to what it detects.

  `Grappa.Repo.LockWatch.sample/2` already collects the holder's scheduler
  `status`, and until this test the only door that reaches a CI container
  log — the `Logger.warning` — threw it away. That field is the whole
  difference between two diagnoses the issue spent days apart on:

    * `:running`  — the holder really is inside the SQLite NIF, so the
      write itself is slow;
    * `:runnable` — the holder is queued and NOT being scheduled, so
      nothing about SQLite is slow and the runtime is the subject;
    * `:waiting`  — the holder is parked in a receive.

  Measured on the real thing (#1420, 2026-08-20): a process blocked inside
  `Exqlite.Sqlite3NIF.execute/2` on a contended `BEGIN IMMEDIATE` reads
  `:running`, and a process parked in a `receive` reads `:waiting`. So the
  field discriminates, and printing it costs one interpolation.

  ## Why this file exists instead of one more case in `lock_watch_test.exs`

  That file buys REAL `SQLITE_BUSY` contention with a private `TmpRepo` on
  a temp file, because its claim is that `acquired` fires only once SQLite
  has granted `RESERVED`. This file's claim is narrower — what the report
  string carries — and it needs no lock at all, so it drives the
  production seam (`LockWatch.observe/1`) directly with parked processes.

  **Honest limit, stated rather than implied:** nothing here proves the
  holder/waiter split is faithful to a real `BEGIN IMMEDIATE`. That is
  `lock_watch_test.exs`'s job and it is not duplicated here.
  """
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias Grappa.Repo.LockWatch

  setup do
    LockWatch.put_test_enabled(true)
    on_exit(fn -> LockWatch.put_test_enabled(false) end)
    :ok
  end

  test "the stall warning names the holder's scheduler status, not only where it is" do
    holder = start_role(:holder)
    waiter = start_role(:waiter)

    await_roles(holder, waiter)

    log = capture_log(fn -> LockWatch.scan(0) end)

    assert log =~ "db lock stall: holder #{inspect(holder)}"

    # A mutant that drops the field — i.e. the message as it stood before
    # #1420b — dies here and nowhere else. The value is `:waiting` and not
    # a wildcard because a parked `receive` is deterministic: a holder that
    # were still running would read `:running`, which is precisely the
    # distinction the field exists to draw.
    assert log =~ "status=:waiting"
  end

  ## ----- helpers --------------------------------------------------------

  # Both roles go through `LockWatch.observe/1`, production's own wrapper:
  # a holder is a transactor that calls `acquired`, a waiter is one that
  # has not called it yet. Re-implementing the edge sequence here would
  # assert against a copy of the mechanism instead of the mechanism.
  defp start_role(role) do
    test_pid = self()

    pid = spawn(fn -> LockWatch.observe(&announce_then_park(role, test_pid, &1)) end)

    # A failed assertion would otherwise leave the process parked inside
    # `observe/1`, holding a watch-table row that poisons every later test.
    on_exit(fn -> Process.exit(pid, :kill) end)

    assert_receive {^role, ^pid}, 5_000

    pid
  end

  # Split out of `start_role/1` so no body nests deeper than two levels.
  # A holder is a transactor that has called `acquired`; a waiter is one
  # that has not.
  defp announce_then_park(role, test_pid, acquired) do
    if role == :holder, do: acquired.()
    send(test_pid, {role, self()})
    park()
  end

  defp park do
    receive do
      :never -> :ok
    end
  end

  # A polled CONDITION, never a sleep: the two `send`s above prove the
  # processes reached `observe/1`, not that the ETS rows are visible yet.
  defp await_roles(holder, waiter), do: await_roles(holder, waiter, 300)

  defp await_roles(holder, waiter, 0) do
    flunk("roles never settled: #{inspect(LockWatch.inspect_lock())} (#{inspect({holder, waiter})})")
  end

  defp await_roles(holder, waiter, attempts) do
    %{holders: holders, waiters: waiters} = LockWatch.inspect_lock()

    if Enum.map(holders, & &1.pid) == [inspect(holder)] and Enum.map(waiters, & &1.pid) == [inspect(waiter)] do
      :ok
    else
      Process.sleep(10)
      await_roles(holder, waiter, attempts - 1)
    end
  end
end
