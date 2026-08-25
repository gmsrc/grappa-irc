defmodule Grappa.Repo.BusyRetryFidelityTest do
  @moduledoc """
  #523 — fidelity check for `Grappa.Repo.BusyRetry.transient_fault?/1`.

  Every OTHER busy-retry test raises a `%Exqlite.Error{}` WE hand-build, so
  they prove our classifier accepts a shape we chose. This one provokes a
  REAL `SQLITE_BUSY` from the driver — two connections on a temp file DB,
  `busy_timeout: 0`, a write transaction held open on one — captures the
  term Ecto actually RAISES, and asserts the classifier matches it. If the
  real message ever drifts from what the injection seam hand-builds, THIS
  test is what catches it (the injected message is aligned to the string
  asserted below).

  `async: false` + a private temp `Ecto.Repo` (unique file per run) so it
  never touches the shared Sandbox — the pool_size:1 Sandbox cannot itself
  reproduce a fast busy, which is the whole reason the engine has a test
  injection seam in the first place.

  ## Coverage honesty — still ONE captured arm

  `transient_fault?/1` accepts an `%Exqlite.Error{}` whose message contains
  **"busy" OR "locked"**. This test captures a REAL error for the **"busy"**
  arm only (`"Database busy"`, the write-lock contention message Ecto raises
  under `pool_size > 1`). The **"locked"** arm is NOT captured from a live
  error here: its evidence is the message OBSERVED at `lib/grappa/repo.ex:24`
  (the #506 connect-time `Exqlite.Error: database is locked` during the WAL
  switch), and every test that exercises it still raises a HAND-BUILT
  `%Exqlite.Error{message: "database is locked"}` (`busy_retry_test.exs:34`,
  `scrollback_test.exs:224`, `scrollback_telemetry_test.exs:116`,
  `notify_test.exs:360`). A second live anchor for the "locked" arm is not
  pursued (its trigger — a fresh-DB connect-time WAL race — is even harder to
  provoke deterministically); this note exists so the gap is stated, not
  silently assumed covered.
  """
  use ExUnit.Case, async: false

  alias Grappa.Repo.BusyRetry

  defmodule TmpRepo do
    use Ecto.Repo, otp_app: :grappa, adapter: Ecto.Adapters.SQLite3
  end

  test "transient_fault?/1 is true for a REAL driver-raised SQLITE_BUSY (not our hand-built struct)" do
    path = Path.join(System.tmp_dir!(), "busy_retry_fidelity_#{System.unique_integer([:positive])}.db")
    on_exit(fn -> Enum.each(["", "-wal", "-shm"], &File.rm(path <> &1)) end)

    {:ok, repo} =
      TmpRepo.start_link(database: path, pool_size: 1, busy_timeout: 0, journal_mode: :wal)

    TmpRepo.query!("CREATE TABLE t(id integer)")

    # Hold the file write-lock on a SEPARATE raw connection so the next Ecto
    # write genuinely contends (busy_timeout 0 → immediate SQLITE_BUSY).
    {:ok, holder} = Exqlite.Sqlite3.open(path)
    :ok = Exqlite.Sqlite3.execute(holder, "PRAGMA busy_timeout=0")
    :ok = Exqlite.Sqlite3.execute(holder, "BEGIN IMMEDIATE")
    :ok = Exqlite.Sqlite3.execute(holder, "INSERT INTO t VALUES (1)")

    raised =
      try do
        TmpRepo.query!("INSERT INTO t VALUES (2)")
        flunk("expected a real SQLITE_BUSY — the write lock was not held")
      rescue
        e -> e
      end

    :ok = Exqlite.Sqlite3.close(holder)
    Supervisor.stop(repo)

    # The driver-raised term is the SAME struct our production `rescue` catches,
    # its real message is "Database busy" (what the injection seam raises), and
    # the shared classifier accepts it.
    assert %Exqlite.Error{} = raised
    assert raised.message =~ ~r/busy/i
    assert BusyRetry.transient_fault?(raised)
  end

  # #1708 — the same fidelity discipline applied to the OTHER pool-disconnect
  # symptom. The chain that ends in `Ecto.MultiplePrimaryKeyError` has four
  # links; three of them are measured here against the SHIPPED driver and the
  # SHIPPED Ecto, and the fourth is a two-line read of
  # `ecto_sql/lib/ecto/adapters/sql.ex:1195-1201` that no test can drive
  # (`struct/10` reaches its adapter through a module-local `query/4`, so the
  # `%Result{}` cannot be injected). Stating which is which is the point:
  #
  #   1. MEASURED below — `Sqlite3.changes/1` on a CLOSED handle answers
  #      `{:error, :connection_closed}`. That is the only branch in
  #      `exqlite/lib/exqlite/connection.ex:657-664` (`maybe_changes/2`) that
  #      yields `nil`, and it yields it by swallowing the tuple in a `_ ->`.
  #   2. MEASURED below — `Sqlite3.transaction_status/1` on the SAME closed
  #      handle answers `{:ok, :error}`, NOT an error tuple. This is the
  #      non-obvious link and the reason the failure is not caught one line
  #      earlier: `execute/4`'s `with` binds that clause with `{:ok, status}`,
  #      so a closed connection sails straight through it into `maybe_changes`
  #      and the result is reported to Ecto as SUCCESS with `num_rows: nil`.
  #   3. MEASURED below — `nil > 1` is TRUE (term order puts every number
  #      before every atom) and Ecto renders `count: nil` as the empty string,
  #      which is the `got  entries` double space prod printed 22 times.
  #   4. READ, not run — `struct/10`'s `case` has clauses for `num_rows: 1`
  #      and `num_rows: 0` and then `num_rows when num_rows > 1`; (3) says
  #      `nil` selects the last one.
  #
  # No test here reproduces the RACE itself (a pool `disconnect/2` landing
  # between a completed step and the `changes()` call). `Exqlite.Connection`
  # re-prepares against `state.db` on every `handle_execute/4`, so a closed
  # handle cannot be smuggled past the public callback, and forcing the window
  # open would mean stepping a statement on a `sqlite3_close_v2`'d connection —
  # deferred-close territory this suite will not build a pin on.
  describe "a closed connection is what produces an empty count (#1708)" do
    test "Sqlite3.changes/1 on a CLOSED handle errors — the one branch maybe_changes/2 turns into nil" do
      {:ok, db} = Exqlite.Sqlite3.open(":memory:")
      :ok = Exqlite.Sqlite3.close(db)

      assert {:error, :connection_closed} = Exqlite.Sqlite3.changes(db)

      # `maybe_changes/2`'s swallow, verbatim from
      # `exqlite/lib/exqlite/connection.ex:657-664`. Deriving the value from
      # the driver rather than writing `nil` is deliberate: the guard below is
      # then measured against what the connection actually produces.
      num_rows =
        case Exqlite.Sqlite3.changes(db) do
          {:ok, total} -> total
          _ -> nil
        end

      assert is_nil(num_rows)

      # `Ecto.Adapters.SQL.struct/10`'s last clause, `num_rows when num_rows >
      # 1` (`ecto_sql/lib/ecto/adapters/sql.ex:1198`). Term order puts every
      # number before every atom, so the guard written to catch "more than one
      # row came back" also catches "no count at all" — and that is the whole
      # reason the raised error names a primary key.
      assert match?(n when n > 1, num_rows)
    end

    test "Sqlite3.transaction_status/1 on a CLOSED handle answers {:ok, :error} — the with does NOT bail" do
      {:ok, db} = Exqlite.Sqlite3.open(":memory:")
      :ok = Exqlite.Sqlite3.close(db)

      # `{:ok, _}`, so `with {:ok, transaction_status} <- ...` MATCHES. Had the
      # driver returned an error tuple here the whole defect would be a clean
      # `{:error, _}` out of `handle_execute/4` and no exception would ever be
      # raised. It does not, and that is why the closed connection survives to
      # the next line.
      assert {:ok, :error} = Exqlite.Sqlite3.transaction_status(db)
    end

    test "Ecto renders a nil count as an EMPTY interpolation — the `got  entries` prod printed" do
      message =
        Ecto.MultiplePrimaryKeyError.exception(
          operation: :insert,
          source: "messages",
          params: [],
          count: nil
        ).message

      # Byte-for-byte the shape prod logged, double space included.
      assert message =~ "expected insert on messages to return at most one entry but got  entries."
    end
  end
end
