defmodule Grappa.RepoWalJournalTest do
  # #506 — `Grappa.Repo.init(:supervisor, _)` pre-switches a fresh database to
  # WAL on ONE connection before the pool (or `mix ecto.migrate`'s ≥2
  # Ecto.Migrator connections) open, so the rollback→WAL `journal_mode` switch
  # never races at connect-time. Pure unit test of the callback — no Repo/pool,
  # no Sandbox. See docs/DESIGN_NOTES.md 2026-07-31.
  use ExUnit.Case, async: true

  alias Exqlite.Sqlite3

  defp journal_mode(path) do
    {:ok, conn} = Sqlite3.open(path)
    {:ok, stmt} = Sqlite3.prepare(conn, "PRAGMA journal_mode")
    {:row, [mode]} = Sqlite3.step(conn, stmt)
    :ok = Sqlite3.release(conn, stmt)
    :ok = Sqlite3.close(conn)
    mode
  end

  # A fresh, non-WAL (rollback/"delete") database file with one real table so
  # the journal mode is persisted + meaningful.
  defp fresh_non_wal_db do
    path =
      Path.join(System.tmp_dir!(), "grappa_wal_init_#{System.unique_integer([:positive])}.db")

    {:ok, conn} = Sqlite3.open(path)
    :ok = Sqlite3.execute(conn, "PRAGMA journal_mode=DELETE")
    :ok = Sqlite3.execute(conn, "CREATE TABLE probe (x INTEGER)")
    :ok = Sqlite3.close(conn)
    on_exit(fn -> for s <- ["", "-wal", "-shm"], do: File.rm(path <> s) end)
    path
  end

  test "init(:supervisor, _) switches a fresh non-WAL db file to WAL" do
    path = fresh_non_wal_db()
    assert journal_mode(path) == "delete"

    assert {:ok, _} =
             Grappa.Repo.init(:supervisor, database: path, busy_timeout: 30_000)

    assert journal_mode(path) == "wal"
  end

  test "init(:supervisor, _) is idempotent on an already-WAL db" do
    path = fresh_non_wal_db()
    {:ok, _} = Grappa.Repo.init(:supervisor, database: path, busy_timeout: 30_000)
    assert {:ok, _} = Grappa.Repo.init(:supervisor, database: path, busy_timeout: 30_000)
    assert journal_mode(path) == "wal"
  end

  test "init(:runtime, _) leaves the database untouched (config-lookup path)" do
    # `repo.config()` calls init(:runtime, _) — including inside ecto.create's
    # storage_up. Acting here would pre-create/pre-WAL the file out from under
    # storage_up, so :runtime MUST stay pure.
    path = fresh_non_wal_db()
    assert {:ok, _} = Grappa.Repo.init(:runtime, database: path, busy_timeout: 30_000)
    assert journal_mode(path) == "delete"
  end

  test "init(:supervisor, _) is a no-op for an in-memory database" do
    assert {:ok, _} = Grappa.Repo.init(:supervisor, database: ":memory:")
  end
end
