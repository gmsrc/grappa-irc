defmodule Grappa.Repo.CheckoutDeadlineReachTest do
  @moduledoc """
  #1657b — which of the waits around a contended write actually ends it:
  SQLite's `busy_timeout`, or DBConnection's checkout deadline?

  ## Why the question is load-bearing

  Production stacks THREE waits on one write, and nothing had ever
  checked them against each other:

      busy_retry budget   1_500ms   config/config.exs
      checkout deadline  15_000ms   Ecto's default `:timeout`, not overridden anywhere
      busy_timeout       30_000ms   config/runtime.exs

  #1421 priced its options against a two-row table whose lock row waits
  *"up to `busy_timeout` = 30_000ms"*. #1657 then added a third fault
  kind, `:interrupted`, and named its cause: the checkout deadline
  firing, which disconnects the holder (`db_connection`'s
  `ConnectionPool.handle_info({:timeout, …})` → `Holder.handle_disconnect/2`)
  and cancels the statement. That deadline sits BETWEEN the other two
  numbers, so which one governs is not a detail.

  ## Method

  ONE independent variable per test: **which of the two numbers is
  smaller.** Same engine, same real held write lock, same statement; the
  verdict is named by production's own `BusyRetry.classify/1`, never by a
  literal here. Magnitudes are scaled down with the RATIO preserved
  (production is 15_000 : 30_000, i.e. 1:2; this runs 300 : 600) — the
  same methodology `Grappa.Repo.BusyRetryBudgetReachTest` justifies for
  the budget, and it keeps the file under two seconds.

  ## What was measured, and what it overturned

  🔴 **The prediction this file was written to confirm was REFUTED, and
  the refutation is the finding.** The expectation was that the deadline,
  being smaller, would cut the wait and surface as `:interrupted`. It
  does cut the wait — the pool logs the checkout timeout and disconnects
  — but the caller sees `:busy_locked` either way:

    * `busy_timeout` smaller → `busy_locked`, 12/12 samples
    * deadline smaller → `busy_locked`, 12/12 samples

  exqlite installs a CUSTOM busy handler that polls `conn->cancelled` and
  **returns 0** when the pool cancels (`c_src/sqlite3_nif.c`); a busy
  handler returning 0 makes SQLite give up with SQLITE_BUSY. So a write
  cancelled while WAITING for the lock is indistinguishable BY CLASS from
  one that exhausted `busy_timeout`. Only the clock separates them.

  Consequence for #1421's table, which is why this was worth measuring:
  the lock row's latency is not `busy_timeout`, it is
  `min(busy_timeout, checkout deadline)`. In production that is 15_000,
  not 30_000, so the ratio against the 1_500 budget is 10 rather than 20.
  The conclusion #1421 drew (the loop collapses to one attempt) is
  unchanged; the number it drew it from is not, and `busy_timeout:
  30_000` never governs a lock-contended write while the deadline is
  smaller.

  ## The discriminator, and a gap it exposes

  `:interrupted` is NOT the lock-wait verdict — it is what a cancellation
  produces when the statement is EXECUTING rather than queued behind the
  lock. That is why #1657's `Bootstrap` casualty was `:interrupted` on a
  READ (`Visitors.list_active/0`): a read never enters the busy handler.

  🔴 **Measured and unfixed: that case is BIMODAL.** Across 63 samples
  over two statement shapes, a cancelled executing statement raised
  `%Exqlite.Error{message: "interrupted"}` ~57% of the time and
  `%Exqlite.Error{message: "out of memory"}` ~43% — and `classify/1`
  calls the latter `:permanent`, so `BusyRetry` RE-RAISES it. That is the
  exact failure mode #1657 exists to remove (a 500 instead of a 503, a
  crash where nothing wraps, a "non-transient DB error" in the log),
  still live for roughly half of its own cases, wearing a message that
  tells the operator they ran out of memory.

  Not an artifact of the harness: the control below uses a streaming
  cross join that allocates nothing which grows, and it splits the same
  way as a recursive CTE did. The C-level cause is NOT established — most
  likely `sqlite3_errmsg` read against a handle the concurrent disconnect
  is already tearing down — and it is NOT observed in production; the
  1.3.0 herd's evidence is `interrupted`, the other half has never been
  seen outside this file.

  Deliberately NOT pinned by an assertion below. The split is roughly
  even, so asserting it would be flaky, and asserting that `:permanent`
  is an acceptable outcome would be asserting a bug. Widening the
  transient set to cover `"out of memory"` is a policy call with a real
  cost — a genuine SQLITE_NOMEM would then be retried and degraded to a
  503 instead of surfacing — so it goes up with the numbers, like
  `pool_size` did, and not into this branch.

  ## What this does NOT resolve

  The #1420 census measured gaps of exactly 30.1s (`lock_watch.ex:19-21`)
  — `busy_timeout` expiring IN FULL, which requires a deadline that did
  not fire. The mechanism established here says that cannot happen while
  a 15_000 deadline is in play, so the two readings still disagree, and
  the disagreement is now sharper rather than resolved: it points at
  WHICH POOL was in that window (#1421 records that both its windows are
  CI and neither is m42; the SQL Sandbox runs `DBConnection.Ownership`,
  not `ConnectionPool`). This file establishes the mechanism on a private
  repo of its own making. It measures no production substrate.
  """
  use ExUnit.Case, async: false

  alias Grappa.Repo.BusyRetry

  defmodule TmpRepo do
    use Ecto.Repo, otp_app: :grappa, adapter: Ecto.Adapters.SQLite3
  end

  # Production's ordering is deadline : busy_timeout = 15_000 : 30_000.
  @short_ms 300
  @long_ms 600

  defp tmp_repo!(prefix, busy_timeout) do
    path = Path.join(System.tmp_dir!(), "#{prefix}_#{System.unique_integer([:positive])}.db")
    on_exit(fn -> Enum.each(["", "-wal", "-shm"], &File.rm(path <> &1)) end)

    {:ok, repo} =
      TmpRepo.start_link(
        database: path,
        pool_size: 1,
        busy_timeout: busy_timeout,
        journal_mode: :wal
      )

    {repo, path}
  end

  # Runs `sql` and reports the production verdict plus the wall-clock.
  # `query_timeout` is the per-query `:timeout` DBConnection turns into the
  # checkout deadline (`Holder.abs_timeout/2` — the timer covers queue AND
  # execution, armed from the moment the checkout is requested).
  defp observe(repo, sql, query_timeout) do
    started = System.monotonic_time(:millisecond)

    class =
      try do
        TmpRepo.query!(sql, [], timeout: query_timeout)
        :no_fault
      rescue
        error in [DBConnection.ConnectionError, Exqlite.Error] -> BusyRetry.classify(error)
      end

    elapsed_ms = System.monotonic_time(:millisecond) - started

    # Teardown BEFORE any assertion, so a red leaves no repo and no held
    # write-lock behind for the next test in this serial file.
    Supervisor.stop(repo)

    %{class: class, elapsed_ms: elapsed_ms}
  end

  # A write that must WAIT: a separate raw connection holds the file
  # write-lock for the whole measurement. Its own busy_timeout is 0 so
  # taking the hold can never itself wait.
  defp observe_contended_write(busy_timeout, query_timeout) do
    {repo, path} = tmp_repo!("checkout_deadline_w", busy_timeout)
    TmpRepo.query!("CREATE TABLE t(id integer)")

    {:ok, holder} = Exqlite.Sqlite3.open(path)
    :ok = Exqlite.Sqlite3.execute(holder, "PRAGMA busy_timeout=0")
    :ok = Exqlite.Sqlite3.execute(holder, "BEGIN IMMEDIATE")
    :ok = Exqlite.Sqlite3.execute(holder, "INSERT INTO t VALUES (1)")

    observed = observe(repo, "INSERT INTO t VALUES (2)", query_timeout)

    :ok = Exqlite.Sqlite3.close(holder)
    observed
  end

  # A statement that is EXECUTING rather than waiting: a streaming cross
  # join, 1000^3 row combinations counted one at a time. O(1) memory by
  # construction, which is what makes it the control for the "out of
  # memory" reading in the moduledoc — a recursive CTE could plausibly
  # exhaust memory on its own; this cannot.
  defp observe_cancelled_execution(query_timeout) do
    {repo, _path} = tmp_repo!("checkout_deadline_x", 0)
    TmpRepo.query!("CREATE TABLE s(x integer)")

    TmpRepo.query!(
      "WITH RECURSIVE g(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM g WHERE i < 1000) " <>
        "INSERT INTO s SELECT i FROM g"
    )

    observe(repo, "SELECT count(*) FROM s a, s b, s c", query_timeout)
  end

  describe "which wait ends a lock-contended write (#1657b)" do
    test "busy_timeout smaller: SQLite's own handler ends it" do
      observed = observe_contended_write(@short_ms, @long_ms)

      assert observed.class == :busy_locked
      assert observed.elapsed_ms < @long_ms
    end

    test "deadline smaller: the POOL ends it — sooner, under the SAME class" do
      observed = observe_contended_write(@long_ms, @short_ms)

      # The class is blind to which wait ran out (see moduledoc: exqlite's
      # busy handler converts the cancellation into a plain SQLITE_BUSY)...
      assert observed.class == :busy_locked

      # ...so the CLOCK is the only witness, and it says `busy_timeout` did
      # not bound this. In production that is the 15_000 deadline capping a
      # 30_000 busy_timeout, which is why the 30_000 never governs here.
      assert observed.elapsed_ms < @long_ms
    end

    test "a cancelled statement that is EXECUTING is never the lock-wait verdict" do
      observed = observe_cancelled_execution(@short_ms)

      # The discriminator is WHERE the cancellation lands, not that one
      # happened. Only the negative is asserted: the positive is bimodal
      # (~57% :interrupted, ~43% :permanent — the unfixed gap in the
      # moduledoc), so pinning it would be flaky AND would encode a bug.
      refute observed.class == :busy_locked
      assert observed.elapsed_ms < @long_ms
    end
  end
end
