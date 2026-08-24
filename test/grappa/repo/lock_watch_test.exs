defmodule Grappa.Repo.LockWatchTest do
  @moduledoc """
  #1420 — the write-lock observer, bought with a REAL `SQLITE_BUSY` wait.

  ## Why a private repo and not the Sandbox

  The suite runs `pool_size: 1` under `Ecto.Adapters.SQL.Sandbox`, where
  every process shares one connection: two writers cannot contend, they
  queue. That is exactly why `Grappa.Repo.BusyRetry` carries a fault
  injection seam at all. But an INJECTED busy would prove nothing here —
  the claim under test is that `acquired` fires only once SQLite has
  actually granted `RESERVED`, and a hand-raised exception never grants
  anything. So this file follows `Grappa.Repo.BusyRetryFidelityTest`: a
  private `TmpRepo` on a temp file with `pool_size: 2`, one process parked
  inside a write transaction and a second genuinely blocked in its
  `BEGIN IMMEDIATE`.

  ## Why the detection pass is driven, not awaited

  `LockWatch.scan/1` is called directly instead of waiting for the
  watchdog's tick. A test that sleeps past a tick interval measures the
  scheduler as much as the code; driving the pass makes the assertions
  deterministic under `--repeat-each`. The barrier before each scan is a
  polled CONDITION (both processes visible in their expected roles), never
  a fixed sleep.

  Both processes are `spawn_monitor`'d rather than linked, so a writer that
  dies takes down an assertion with a readable reason instead of the test
  process.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog

  alias Grappa.Repo.LockWatch

  defmodule TmpRepo do
    @moduledoc false
    use Ecto.Repo, otp_app: :grappa, adapter: Ecto.Adapters.SQLite3
  end

  @detected [:grappa, :repo, :lock_stall, :detected]
  @unattributed [:grappa, :repo, :lock_stall, :unattributed]

  # 🔴 TWO CLOCKS BOUND EVERY TEST HERE, AND THEY HAVE TO BE ORDERED.
  #
  # The queued writer stays queued only while SQLite's busy handler keeps
  # waiting for it: `busy_timeout` is a hard wall-clock budget that starts at
  # that writer's `BEGIN IMMEDIATE` and has to cover everything the test does
  # before it releases the holder. ExUnit's own per-test deadline is the other
  # clock. While the budget was the SMALLER of the two, a runner slow enough to
  # push a test past it killed the WAITER first, and the test then reported the
  # consequence — a telemetry message that never arrived, with an unrelated
  # `%Exqlite.Error{message: "database is locked"}` sitting in the mailbox —
  # rather than "this test is too slow" (#1687, CI run 32663241142).
  #
  # Measured on 29bea21d, in this file's own topology: the budget is
  # wall-clock and load-INSENSITIVE (`30_000` configured → 32.9s idle and
  # 32.8s with 32 spinning processes; `500` → 586ms, `2_000` → 4.2s, so it
  # tracks the setting), while every test in this file costs 15–378ms. So the
  # cure is not a bigger guess at the budget: it is the ORDER. Derive the
  # budget FROM the test deadline and no test ExUnit still allows to run can
  # outlive its own waiter — a stalled runner then fails as an ExUnit timeout,
  # which names the test and the line instead of the symptom.
  #
  # This is the same move as `observed_write/3`'s `timeout: :infinity`, one
  # layer out: that one removed the checkout deadline so `busy_timeout` was
  # the only bound left, and this one bounds `busy_timeout` in turn.
  @test_timeout_ms 60_000
  @moduletag timeout: @test_timeout_ms
  @waiter_budget_ms @test_timeout_ms * 2

  setup do
    LockWatch.put_test_enabled(true)
    on_exit(fn -> LockWatch.put_test_enabled(false) end)

    handler = "lock-watch-test-#{System.unique_integer([:positive])}"
    test_pid = self()

    # Both doors on ONE handler, tagged by event: a test that asserts the
    # attributed line fired must also be able to REFUTE the unattributed one
    # (and vice versa). Two separate handlers would let a mutant that emits
    # both pass every assertion in the file.
    :ok =
      :telemetry.attach_many(
        handler,
        [@detected, @unattributed],
        fn
          @detected, measurements, metadata, _ -> send(test_pid, {:stall, measurements, metadata})
          @unattributed, measurements, metadata, _ -> send(test_pid, {:unattributed, measurements, metadata})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler) end)

    :ok
  end

  describe "holder vs waiter under a real BEGIN IMMEDIATE contention" do
    test "names the HOLDER, lists the blocked writer as a waiter, and samples the holder's live stack" do
      repo = start_tmp_repo()

      {holder, holder_ref} = start_writer(1, :park)
      assert_receive {:holding, ^holder}, 5_000

      {waiter, waiter_ref} = start_writer(2, :straight_through)

      await_roles(holder, [waiter])

      LockWatch.scan(0)

      assert_receive {:stall, measurements, stall}, 1_000

      # M1 — a mutant that reports the longest-queued WAITER as the holder
      # (the two roles are symmetric in the table; only the tag separates
      # them) has to survive both of these to live.
      assert stall.holder.pid == inspect(holder)
      assert [waiter_sample] = stall.waiters
      assert waiter_sample.pid == inspect(waiter)

      # M2 — a mutant that never promotes `:waiting` to `:holding` leaves no
      # holder at all, so there is nothing to report and this never arrives;
      # a mutant that promotes TOO EARLY (before the transaction opens)
      # promotes the blocked writer too, and the waiter count goes to zero.
      assert stall.waiter_count == 1
      assert measurements.waiter_count == 1
      assert is_integer(measurements.held_ms)

      # M4 — a mutant sampling `self()` (the scanning process) instead of
      # the holder's pid still produces a well-formed record, and only the
      # CONTENT of the stack tells the two apart. This frame is the reason
      # the holder is stuck, which is the datum #1420 says is missing.
      assert Enum.any?(stall.holder.stacktrace, &(&1 =~ "park_until_released"))

      # #1687 — the two arms are mutually exclusive by construction. A mutant
      # that emits the unattributed line unconditionally (rather than only
      # when nothing was named) would double-report every real stall, and the
      # operator would learn to ignore both.
      refute_receive {:unattributed, _, _}, 100

      send(holder, :release)
      assert_receive {:DOWN, ^holder_ref, :process, ^holder, :normal}, 5_000
      assert_receive {:DOWN, ^waiter_ref, :process, ^waiter, :normal}, 10_000

      Supervisor.stop(repo)
    end

    test "a holder that has not crossed the threshold is not reported, queue or no queue" do
      repo = start_tmp_repo()

      {holder, holder_ref} = start_writer(1, :park)
      assert_receive {:holding, ^holder}, 5_000

      {waiter, waiter_ref} = start_writer(2, :straight_through)

      await_roles(holder, [waiter])

      # M5 — a mutant that drops the `elapsed >= threshold` comparison
      # reports immediately and dies here. The holder has been holding for
      # milliseconds, not the ten seconds demanded.
      LockWatch.scan(10_000)

      refute_receive {:stall, _, _}, 300

      send(holder, :release)
      assert_receive {:DOWN, ^holder_ref, :process, ^holder, :normal}, 5_000
      assert_receive {:DOWN, ^waiter_ref, :process, ^waiter, :normal}, 10_000

      Supervisor.stop(repo)
    end

    test "a slow but UNCONTENDED holder is not a stall" do
      repo = start_tmp_repo()

      {holder, holder_ref} = start_writer(1, :park)
      assert_receive {:holding, ^holder}, 5_000

      await_roles(holder, [])

      # M3 — a mutant that emits on a slow holder without checking for a
      # queue behind it fires here. Nobody is blocked: this transaction is
      # slow, and slow is not a stall. Reporting it would bury the signal
      # the instrument exists to find under every long write in the system.
      LockWatch.scan(0)

      refute_receive {:stall, _, _}, 300

      send(holder, :release)
      assert_receive {:DOWN, ^holder_ref, :process, ^holder, :normal}, 5_000

      Supervisor.stop(repo)
    end
  end

  describe "a queue with no attributable holder (#1687)" do
    test "reports the queue instead of staying silent, and says the holder was never attributed" do
      repo = start_tmp_repo()

      {blind, blind_ref} = start_unobserved_writer(1)
      assert_receive {:holding, ^blind}, 5_000

      {waiter, waiter_ref} = start_writer(2, :straight_through)

      await_roles(nil, [waiter])

      # The LOG is the door that failed in prod: LockWatch was armed through a
      # three-minute episode and put NOT ONE line in `erlang.log.5`, so the
      # #1429 census and the operator both read a healthy system. Pinning the
      # telemetry alone would leave exactly the door that was dark, dark.
      log = capture_log(fn -> LockWatch.scan(0) end)

      assert log =~ "db lock stall UNATTRIBUTED"
      assert log =~ "no holder registered"

      assert_receive {:unattributed, measurements, report}, 1_000

      # M6 — a mutant reporting the holder-less queue with a fabricated holder
      # (the shape the issue's own wording invites) dies here: there is no
      # holder to name, and the record says so rather than guessing.
      assert report.holders_registered == 0

      # M7 — a mutant sampling `self()` (the scanning process) instead of the
      # queued writers still produces a well-formed record; only the pid tells
      # them apart. The waiters ARE the payload here — they are the only thing
      # the instrument can honestly show.
      assert [sample] = report.waiters
      assert sample.pid == inspect(waiter)
      assert is_integer(sample.elapsed_ms)

      assert measurements.waiter_count == 1
      assert is_integer(measurements.longest_wait_ms)

      # M8 — the queue is NOT a named stall. A mutant that routes this through
      # the attributed door would put a `holder` key on a record that has none.
      refute_receive {:stall, _, _}, 100

      send(blind, :release)
      assert_receive {:DOWN, ^blind_ref, :process, ^blind, :normal}, 5_000
      assert_receive {:DOWN, ^waiter_ref, :process, ^waiter, :normal}, 10_000

      Supervisor.stop(repo)
    end

    test "a queue that has not crossed the threshold is not reported either" do
      repo = start_tmp_repo()

      {blind, blind_ref} = start_unobserved_writer(1)
      assert_receive {:holding, ^blind}, 5_000

      {waiter, waiter_ref} = start_writer(2, :straight_through)

      await_roles(nil, [waiter])

      # M9 — the mirror of M5 on the new arm. A mutant that drops the
      # threshold comparison for waiters turns every transient queue behind
      # every autocommit write into a warning, which on the hot path is a log
      # flood, not a signal.
      LockWatch.scan(10_000)

      refute_receive {:unattributed, _, _}, 300

      send(blind, :release)
      assert_receive {:DOWN, ^blind_ref, :process, ^blind, :normal}, 5_000
      assert_receive {:DOWN, ^waiter_ref, :process, ^waiter, :normal}, 10_000

      Supervisor.stop(repo)
    end

    test "one line per queued cohort, not one per watchdog tick" do
      repo = start_tmp_repo()

      {blind, blind_ref} = start_unobserved_writer(1)
      assert_receive {:holding, ^blind}, 5_000

      {waiter, waiter_ref} = start_writer(2, :straight_through)

      await_roles(nil, [waiter])

      LockWatch.scan(0)
      assert_receive {:unattributed, _, _}, 1_000

      # M10 — the prod episode ran ~170s at `tick_ms: 1_000`. A mutant that
      # forgets to arm the row's `reported?` flag prints ~170 identical
      # warnings for one episode, which is the same as printing none.
      LockWatch.scan(0)
      refute_receive {:unattributed, _, _}, 300

      send(blind, :release)
      assert_receive {:DOWN, ^blind_ref, :process, ^blind, :normal}, 5_000
      assert_receive {:DOWN, ^waiter_ref, :process, ^waiter, :normal}, 10_000

      Supervisor.stop(repo)
    end

    test "a waiter already reported as unattributed is still reportable once it becomes the holder" do
      repo = start_tmp_repo()

      {blind, blind_ref} = start_unobserved_writer(1)
      assert_receive {:holding, ^blind}, 5_000

      {writer, writer_ref} = start_writer(2, :park)
      await_roles(nil, [writer])

      LockWatch.scan(0)
      assert_receive {:unattributed, _, _}, 1_000

      # The unregistered writer lets go; the pid that was just reported as a
      # WAITER now takes RESERVED itself.
      send(blind, :release)
      assert_receive {:DOWN, ^blind_ref, :process, ^blind, :normal}, 5_000
      assert_receive {:holding, ^writer}, 10_000

      {queued, queued_ref} = start_writer(3, :straight_through)
      await_roles(writer, [queued])

      LockWatch.scan(0)

      # 🔴 M11, and it is the whole reason this test exists. `acquired/0`
      # promotes the row's role and restarts its clock but leaves the
      # `reported?` flag exactly where it was, so a pid reported once as a
      # waiter would be permanently unreportable as a HOLDER — the cure for
      # the unattributed blindness having quietly blinded the attributed path
      # that already worked. The flag has to clear on promotion, because the
      # promotion starts a new episode with a new clock.
      assert_receive {:stall, _, stall}, 1_000
      assert stall.holder.pid == inspect(writer)

      send(writer, :release)
      assert_receive {:DOWN, ^writer_ref, :process, ^writer, :normal}, 5_000
      assert_receive {:DOWN, ^queued_ref, :process, ^queued, :normal}, 10_000

      Supervisor.stop(repo)
    end
  end

  describe "the production seam" do
    test "Grappa.Repo.immediate_transaction/1 registers its caller as the holder, and clears on exit" do
      me = inspect(self())

      # Pins that the observer is actually WIRED to the production function,
      # in the right place. The tests above drive `LockWatch.observe/1`
      # themselves, so on their own they would still pass if
      # `immediate_transaction/1` had never been instrumented at all.
      #
      # Honest limit: the DataCase sandbox already holds a transaction on
      # this connection, and `Exqlite.Connection.handle_begin/2` emits
      # SAVEPOINT rather than BEGIN IMMEDIATE in that state
      # (deps/exqlite/lib/exqlite/connection.ex:310-315). So this pins the
      # WIRING and the edge ORDER; the real `RESERVED` acquisition is what
      # the TmpRepo tests above measure.
      assert {:ok, %{holders: holders}} =
               Grappa.Repo.immediate_transaction(fn -> LockWatch.inspect_lock() end)

      assert Enum.any?(holders, &(&1.pid == me))

      assert %{holders: [], waiters: []} = LockWatch.inspect_lock()
    end
  end

  # `:logger_config` caches "may this module log?" under one
  # `persistent_term` key PER MODULE, and writes it the first time that
  # module logs. `allow/2` stores `?PRIMARY_TO_CACHE(get_primary_level())`,
  # so the cached value is the PRIMARY level — the same for every module,
  # and unrelated to the level of the call that happened to arrive first.
  @logger_module_cache {:logger_config, LockWatch}
  @logger_primary_cache {:logger_config, :"$primary_config$"}

  describe "the logger module cache (#1715)" do
    test "init/1 primes it, so no report path pays the first persistent_term:put" do
      # A `persistent_term` write blocks on a thread-progress barrier, and a
      # SQLite busy handler sleeping out its `busy_timeout` on a dirty-IO
      # scheduler holds that barrier. So whichever call site logs FIRST from
      # this module pays a wait of up to the whole `busy_timeout` — and the
      # first line this module ever emits is, by construction, its stall
      # report: the one thing that must not wait on the stall it is
      # reporting. Paying the put at `init/1` moves it to boot, where no
      # write lock is held.
      #
      # Erasing first is what gives the assertion teeth: without it the key
      # is already there from the application's own boot and the test would
      # pass with the priming deleted.
      :persistent_term.erase(@logger_module_cache)
      assert :persistent_term.get(@logger_module_cache, :absent) == :absent

      restart_lock_watch()

      assert :persistent_term.get(@logger_module_cache, :absent) ==
               :persistent_term.get(@logger_primary_cache)
    end
  end

  describe "the barrier itself (#1747)" do
    test "a slow predicate cannot push the barrier past its own budget" do
      # #1747 — six unrelated PRs went red here with a 60 s `ExUnit.TimeoutError`
      # and NEVER with `await_until`'s own `flunk`, which is the diagnosis this
      # helper exists to print. That is arithmetic, not luck: an attempt count
      # is not a budget. Bounded at 300 attempts the helper spends ~3 s on a
      # healthy runner and well past ExUnit's 60 s ceiling on a starved one, so
      # exactly when the failure is interesting the honest message becomes
      # unreachable and the report shows a stack sampled from wherever the loop
      # happened to be.
      #
      # A 30 ms predicate is the starved runner, compressed: under the attempt
      # bound this call costs 200 * (30 + 10) ms = 8 s, under a wall-clock bound
      # it costs the budget.
      budget_ms = 200

      {elapsed_us, _} =
        :timer.tc(fn ->
          assert_raise ExUnit.AssertionError, fn ->
            await_until(
              fn ->
                Process.sleep(30)
                false
              end,
              budget_ms
            )
          end
        end)

      assert div(elapsed_us, 1000) < 10 * budget_ms
    end

    test "lock_roles/0 names the same holders and waiters inspect_lock/0 does" do
      # The barrier compares pid lists and nothing else, but `inspect_lock/0`
      # formats a 12-frame stacktrace per sampled process to answer it. This
      # pins the cheap projection to the expensive one so the barrier can stop
      # paying for a diagnostic it never reads — and so a reimplementation that
      # drifts from `partition/2` reddens here instead of silently disagreeing
      # with the instrument it is supposed to mirror.
      repo = start_tmp_repo()

      {holder, holder_ref} = start_writer(1, :park)
      assert_receive {:holding, ^holder}, 5_000

      {waiter, waiter_ref} = start_writer(2, :straight_through)

      await_roles(holder, [waiter])

      %{holders: held, waiters: queued} = LockWatch.lock_roles()
      %{holders: held_samples, waiters: queued_samples} = LockWatch.inspect_lock()

      assert Enum.map(held, &inspect/1) == pids(held_samples)
      assert Enum.sort(Enum.map(queued, &inspect/1)) == Enum.sort(pids(queued_samples))
      assert held == [holder]
      assert queued == [waiter]

      send(holder, :release)
      assert_receive {:DOWN, ^holder_ref, :process, ^holder, :normal}, 5_000
      assert_receive {:DOWN, ^waiter_ref, :process, ^waiter, :normal}, 10_000

      Supervisor.stop(repo)
    end
  end

  ## ----- helpers --------------------------------------------------------

  # Drives the REAL `init/1` — the only way to prove the priming is wired
  # into it rather than merely available as a function. Calling `init/1`
  # directly is not an option: it creates a `:named_table`, which the live
  # child already owns.
  #
  # A child left stopped would poison every test after this one, so the
  # restore is registered BEFORE the terminate, and tolerates the child
  # already running — the happy path restarts it here, in the test body,
  # where a failure is attributable.
  defp restart_lock_watch do
    on_exit(fn ->
      case Supervisor.restart_child(Grappa.Supervisor, LockWatch) do
        {:ok, _} -> :ok
        {:error, :running} -> :ok
      end
    end)

    :ok = Supervisor.terminate_child(Grappa.Supervisor, LockWatch)
    {:ok, _} = Supervisor.restart_child(Grappa.Supervisor, LockWatch)

    :ok
  end

  defp start_tmp_repo do
    path = Path.join(System.tmp_dir!(), "lock_watch_#{System.unique_integer([:positive])}.db")
    on_exit(fn -> Enum.each(["", "-wal", "-shm"], &File.rm(path <> &1)) end)

    # busy_timeout is the waiter's whole life: it must still be WAITING when
    # the scan runs, and a short timeout would turn it into an error path and
    # measure `BusyRetry` instead of this module. The value is DERIVED from the
    # test deadline rather than chosen — see `@waiter_budget_ms` for why the
    # two clocks have to be ordered and what a mis-order looks like.
    #
    # It is NOT the only wait on that writer, and on its own it does not
    # govern — see `observed_write/3`.
    {:ok, repo} =
      TmpRepo.start_link(
        database: path,
        pool_size: 2,
        busy_timeout: @waiter_budget_ms,
        journal_mode: :wal
      )

    TmpRepo.query!("CREATE TABLE t(id integer)")

    repo
  end

  # A writer that goes through the SAME `LockWatch.observe/1` production
  # uses — re-implementing the edge sequence here would test a copy of the
  # mechanism rather than the mechanism.
  defp start_writer(id, after_insert) do
    test_pid = self()

    {pid, ref} = spawn_monitor(fn -> observed_write(id, after_insert, test_pid) end)

    # A failing assertion would otherwise leave this process parked inside
    # its transaction, holding both the file lock and a watch-table row, and
    # poison every test that follows.
    on_exit(fn -> Process.exit(pid, :kill) end)

    {pid, ref}
  end

  # Split out of `start_writer/2` so no body nests deeper than two levels.
  # `observe/1` is production's own wrapper — the point is that the test
  # drives the real edge sequence rather than a hand-written copy of it.
  #
  # 🔴 `timeout: :infinity` is load-bearing, and it is what makes
  # `start_tmp_repo/0`'s `busy_timeout: @waiter_budget_ms` mean what that
  # comment says it means. Without it both writers inherit Ecto's DEFAULT
  # `:timeout` of 15_000 (`ecto_sql/lib/ecto/adapters/sql.ex`), which
  # DBConnection arms as a checkout deadline covering the WHOLE transaction
  # — queue, statements and the holder's park alike. So the real wait was
  # `min(15_000, the budget)` — cited by anchor because #1687 moved that
  # budget off its literal and the number here would have rotted with it —
  # the smaller number was never written down anywhere, and once a loaded
  # runner pushed the window past 15s the pool disconnected BOTH
  # connections: the parked holder mid-park, and the waiter mid-`BEGIN
  # IMMEDIATE`. exqlite's busy handler answers a cancellation with plain
  # SQLITE_BUSY, so the waiter died `%Exqlite.Error{message: "database is
  # locked"}` instead of exiting `:normal` — a red naming this file's
  # waiter assertion, on a machine slow enough, with nothing in the source
  # to point at. #1657b measured that ordering (deadline caps busy_timeout,
  # and the cap is invisible by error CLASS); this is the same finding
  # landing on the harness that assumed otherwise.
  #
  # Measured, on `29bea21d` with a 16s delay injected before the release:
  # without this option the waiter dies `database is locked` and the
  # waiter-DOWN assertion fails; with it, 4 tests / 0 failures, assertions
  # untouched. `busy_timeout` is now the only wait bounding the waiter,
  # which is what this file was always documented to be testing.
  defp observed_write(id, after_insert, test_pid) do
    LockWatch.observe(fn acquired ->
      TmpRepo.transaction(fn -> insert_then(id, after_insert, test_pid, acquired) end,
        mode: :immediate,
        timeout: :infinity
      )
    end)
  end

  # #1687 — a writer that takes RESERVED WITHOUT going through
  # `LockWatch.observe/1`: it holds the file lock and owns no row in the watch
  # table. That is the production blindness in person.
  #
  # Honest limit, and it is why this is not literally `TmpRepo.insert/2`: the
  # production writer is a bare autocommit statement
  # (`Scrollback.persist_row/1` -> `Repo.insert/2`,
  # `lib/grappa/scrollback.ex:227`), and an autocommit statement cannot be
  # held open from outside — it commits the moment it returns, so it cannot be
  # parked while a second writer queues behind it. An un-observed
  # `mode: :immediate` transaction CAN be parked, and the state `detect/2`
  # actually reads is byte-identical between the two: RESERVED held, zero rows
  # in the watch table. This harness reproduces the OBSERVABLE state, not the
  # statement shape.
  defp start_unobserved_writer(id) do
    test_pid = self()

    {pid, ref} = spawn_monitor(fn -> unobserved_write(id, test_pid) end)

    on_exit(fn -> Process.exit(pid, :kill) end)

    {pid, ref}
  end

  # `timeout: :infinity` for the same reason `observed_write/3` carries it —
  # see the 🔴 note there. Without it the park is capped at Ecto's default
  # 15_000 checkout deadline rather than by this test's own release message.
  defp unobserved_write(id, test_pid) do
    TmpRepo.transaction(
      fn ->
        TmpRepo.query!("INSERT INTO t VALUES (?)", [id])
        send(test_pid, {:holding, self()})
        park_until_released()
      end,
      mode: :immediate,
      timeout: :infinity
    )
  end

  defp insert_then(id, after_insert, test_pid, acquired) do
    acquired.()
    TmpRepo.query!("INSERT INTO t VALUES (?)", [id])
    send(test_pid, {:holding, self()})
    if after_insert == :park, do: park_until_released()
  end

  # Named, and named distinctively, because its frame IS the oracle for the
  # holder-stack assertion.
  defp park_until_released do
    receive do
      :release -> :ok
    end
  end

  # `holder` is `nil` for the #1687 topology — a queue whose holder owns no
  # row, so the barrier is "holders is EMPTY and these pids are queued".
  defp await_roles(holder, waiters) do
    await_until(
      fn ->
        %{holders: held, waiters: queued} = LockWatch.inspect_lock()

        pids(held) == expected_holders(holder) and
          Enum.sort(pids(queued)) == Enum.sort(Enum.map(waiters, &inspect/1))
      end,
      300
    )
  end

  defp expected_holders(nil), do: []
  defp expected_holders(holder), do: [inspect(holder)]

  defp pids(samples), do: Enum.map(samples, & &1.pid)

  defp await_until(_, 0), do: flunk("condition never held: #{inspect(LockWatch.inspect_lock())}")

  defp await_until(fun, attempts) do
    if fun.() do
      :ok
    else
      Process.sleep(10)
      await_until(fun, attempts - 1)
    end
  end
end
