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
end
