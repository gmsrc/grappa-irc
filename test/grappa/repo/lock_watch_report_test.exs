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

  test "the UNATTRIBUTED warning refuses to name a holder, and says which kind of silence it is" do
    waiter = start_role(:waiter)

    await_queue_only(waiter)

    log = capture_log(fn -> LockWatch.scan(0) end)

    # #1687 — in prod this was the empty string for ~170 seconds.
    assert log =~ "db lock stall UNATTRIBUTED: 1 writer(s) queued past the threshold"
    assert log =~ "no holder registered"

    # 🔴 The load-bearing negative. The issue's own wording ("holder
    # unattributed") invites a line that still asserts a HOLD by an
    # unregistered writer. Prod says that inference is unsafe: the victims'
    # 62 s decomposes into ~31 s of pool checkout plus ~31 s of
    # `busy_timeout`, so pool queueing is a live cause and this frame
    # measured neither. A mutant that reinstates the claim dies here.
    refute log =~ "held"
    assert log =~ "NOT attributable at the BEGIN IMMEDIATE seam"

    # What it CAN vouch for: which waiter, and where it is parked — the one
    # field that separates "blocked on the lock" from "queued for a
    # connection" without guessing between them.
    assert log =~ "longest waiter #{inspect(waiter)}"
    assert log =~ "status=:waiting"
  end

  test "a holder registered but still under the threshold is reported as such, not as no holder" do
    # Order is the point: the waiter must be measurably OLDER than the
    # holder, so one threshold can sit between them. Both are registered.
    #
    # The waiter has to be AGED before the holder starts, and starting them
    # back to back is not enough — measured: `acquired/0` restarts the
    # holder's clock at promotion, which lands microseconds after its own
    # `waiting/0`, so two roles started together read the SAME elapsed and no
    # threshold can separate them.
    waiter = start_role(:waiter)
    await_age(waiter, 150)
    holder = start_role(:holder)

    # A polled CONDITION on the instrument's own reading, never a sleep. The
    # 100ms margin is what makes the threshold choice below safe: the arm
    # under test only mis-selects if this process is descheduled for 50ms
    # between the reading and the scan on the next line.
    {holder_ms, waiter_ms} = await_gap(holder, waiter, 100)

    log = capture_log(fn -> LockWatch.scan(holder_ms + 50) end)

    assert waiter_ms > holder_ms + 100

    # M — a mutant that reports `holders_registered` as a plain boolean, or
    # that hardcodes the "no holder" clause because it is the case the issue
    # described, cannot tell an operator whether the seam is working. These
    # two sub-cases call for opposite next moves: widen coverage, versus
    # nothing at all because the queue is simply older than the holder.
    assert log =~ "db lock stall UNATTRIBUTED"
    assert log =~ "1 holder(s) registered, none past the threshold"
    refute log =~ "no holder registered"
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

  # #1687 — the queue-with-no-holder barrier. Same discipline as
  # `await_roles/2`: the `send` proves the process reached `observe/1`, not
  # that its ETS row is visible yet.
  defp await_queue_only(waiter), do: await_queue_only(waiter, 300)

  defp await_queue_only(waiter, 0) do
    flunk("queue never settled: #{inspect(LockWatch.inspect_lock())} (#{inspect(waiter)})")
  end

  defp await_queue_only(waiter, attempts) do
    %{holders: holders, waiters: waiters} = LockWatch.inspect_lock()

    if holders == [] and Enum.map(waiters, & &1.pid) == [inspect(waiter)] do
      :ok
    else
      Process.sleep(10)
      await_queue_only(waiter, attempts - 1)
    end
  end

  # Polls until `waiter`'s own row has aged past `ms`. Read off the
  # instrument rather than slept, so a loaded runner waits longer instead of
  # asserting against a clock it never checked.
  defp await_age(waiter, ms), do: await_age(waiter, ms, 300)

  defp await_age(waiter, ms, 0) do
    flunk("waiter never aged to #{ms}ms: #{inspect(LockWatch.inspect_lock())} (#{inspect(waiter)})")
  end

  defp await_age(waiter, ms, attempts) do
    case LockWatch.inspect_lock() do
      %{waiters: [%{pid: pid, elapsed_ms: elapsed}]} when elapsed >= ms ->
        ^pid = inspect(waiter)
        :ok

      _ ->
        Process.sleep(10)
        await_age(waiter, ms, attempts - 1)
    end
  end

  # Polls until the waiter is at least `margin` ms older than the holder, and
  # returns both readings so the caller can place a threshold between them.
  defp await_gap(holder, waiter, margin), do: await_gap(holder, waiter, margin, 300)

  defp await_gap(holder, waiter, margin, 0) do
    flunk("gap never opened: #{inspect(LockWatch.inspect_lock())} (#{inspect({holder, waiter, margin})})")
  end

  defp await_gap(holder, waiter, margin, attempts) do
    %{holders: holders, waiters: waiters} = LockWatch.inspect_lock()

    with [%{pid: h_pid, elapsed_ms: h_ms}] <- holders,
         [%{pid: w_pid, elapsed_ms: w_ms}] <- waiters,
         true <- h_pid == inspect(holder) and w_pid == inspect(waiter),
         true <- w_ms > h_ms + margin do
      {h_ms, w_ms}
    else
      _ ->
        Process.sleep(10)
        await_gap(holder, waiter, margin, attempts - 1)
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
