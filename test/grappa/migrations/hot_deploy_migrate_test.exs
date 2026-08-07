defmodule Grappa.HotMigrateSmokeRepo do
  use Ecto.Repo,
    otp_app: :grappa,
    adapter: Ecto.Adapters.SQLite3
end

defmodule Grappa.Migrations.HotDeployMigrateTest do
  @moduledoc """
  The gate whose absence #41's Testing section named, and whose absence
  the previous round declared rather than hid: `migrate_and_reload/2`
  driven against a **live supervised pool on a real sqlite file**.

  Injected effects prove ORDER and ABORT. They cannot prove the migrate
  works at all — single-writer sqlite, WAL, `busy_timeout` against live
  readers is a different question, and it is the one whose failure never
  shows in CI and does show in production (a `Session.Server` crash
  takes its linked `IRC.Client` and the upstream socket with it).

  Only the module reload is a probe here, for the reason
  `Grappa.HotReload`'s own test file states: walking the real app ebin
  mid-suite de-instruments every module and corrupts coverage. That
  probe is also the measuring instrument — it asserts the schema change
  is ALREADY visible when it runs, which is the ordering claim stated as
  an observation rather than as a call sequence.

  ## The two anchors

  The last two migrations happen to be one of each, adjacent, so each
  scenario has exactly ONE pending file and the assertions name it:

    * `20260803090000_add_user_passkeys` — COLD
    * `20260805100000_add_old_nick_to_session_log_events` — HOT, and the
      migration whose moduledoc claimed "HOT" in prose all along.
  """

  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL
  alias Grappa.HotMigrateSmokeRepo, as: SmokeRepo
  alias Grappa.HotReload

  @totp_version 20_260_802_190_000
  @passkeys_version 20_260_803_090_000
  @old_nick_version 20_260_805_100_000

  @passkeys_file "20260803090000_add_user_passkeys.exs"
  @old_nick_file "20260805100000_add_old_nick_to_session_log_events.exs"

  setup do
    path =
      Path.join(System.tmp_dir!(), "grappa-hot-migrate-#{System.unique_integer([:positive])}.db")

    # `priv: "priv/repo"` is load-bearing: without it Ecto derives the
    # migrations dir from the REPO NAME (priv/hot_migrate_smoke_repo),
    # and `Ecto.Migrator.migrations_path/1` — which the production code
    # under test calls — would resolve somewhere empty. With it, this
    # repo reads the same real directory Grappa.Repo does, so the path
    # resolution is exercised rather than bypassed.
    #
    # `pool_size: 2` is NOT arbitrary and NOT a knob turned until the
    # suite went green. Measured here: replaying the WHOLE migration
    # graph onto an empty file fails 10/10 at `pool_size: 5` and passes
    # 10/10 at 2, deterministically, with `20260516184555` unable to see
    # the column `20260516154723` adds one migration earlier. It is not
    # the #506 rollback→WAL race: replicating `Grappa.Repo.init/2`'s
    # serial pre-switch before the pool opens changes nothing (10/10
    # still red). Two is also what every other migration path in the
    # project already uses — `Ecto.Migrator.with_repo/2` forces
    # `pool_size: 2` — so the graph replay has never run wider than this
    # anywhere. See the pool-size test below for the case that DOES
    # matter to #41, and DESIGN_NOTES for what is still unexplained.
    start_pool!(path, 2)

    on_exit(fn ->
      Application.delete_env(:grappa, SmokeRepo)
      File.rm(path)
      File.rm(path <> "-shm")
      File.rm(path <> "-wal")
    end)

    %{path: path}
  end

  defp start_pool!(path, pool_size) do
    Application.put_env(:grappa, SmokeRepo,
      database: path,
      priv: "priv/repo",
      pool_size: pool_size,
      busy_timeout: 30_000,
      foreign_keys: :on
    )

    start_supervised!(SmokeRepo)
  end

  defp migrate_to(version) do
    Ecto.Migrator.run(SmokeRepo, :up, to: version, log: false)
  end

  defp applied_versions do
    SmokeRepo
    |> SQL.query!("SELECT version FROM schema_migrations ORDER BY version", [])
    |> Map.fetch!(:rows)
    |> List.flatten()
  end

  defp columns(table) do
    SmokeRepo
    |> SQL.query!("SELECT name FROM pragma_table_info(?)", [table])
    |> Map.fetch!(:rows)
    |> List.flatten()
  end

  defp noop_reload, do: %{reloaded: [], failed: []}

  describe "pending_migration_files/1 against a live pool" do
    test "resolves the real migrations dir and names exactly what is unapplied" do
      migrate_to(@passkeys_version)

      assert [path] = HotReload.pending_migration_files(SmokeRepo)
      assert Path.basename(path) == @old_nick_file
      assert File.exists?(path)
    end

    test "nothing unapplied → empty" do
      migrate_to(@old_nick_version)
      assert [] = HotReload.pending_migration_files(SmokeRepo)
    end
  end

  describe "migrate_and_reload/2 — a pending EXPAND is applied for real" do
    test "the column does not exist, then it does, and the reload sees it already there" do
      migrate_to(@passkeys_version)
      refute "old_nick" in columns("session_log_events")

      # The probe runs where the module reload runs. Asserting the new
      # column from INSIDE it is the ordering claim measured rather than
      # asserted: if the reload ran first, this read would fail.
      parent = self()

      probe = fn ->
        send(parent, {:columns_at_reload, columns("session_log_events")})
        noop_reload()
      end

      assert {:ok, %{migrated: [@old_nick_version], reloaded: [], failed: []}} =
               HotReload.migrate_and_reload(SmokeRepo, probe)

      assert_received {:columns_at_reload, at_reload}
      assert "old_nick" in at_reload

      assert "old_nick" in columns("session_log_events")
      assert @old_nick_version in applied_versions()
    end

    test "an old-code INSERT that omits the new column still lands — the expand claim itself" do
      migrate_to(@passkeys_version)
      assert {:ok, _} = HotReload.migrate_and_reload(SmokeRepo, &noop_reload/0)

      # Exactly the write shape the still-loaded old code performs: every
      # column it knew about, and nothing else. If this raised, "expand
      # has a zero crash window" would be false.
      SQL.query!(
        SmokeRepo,
        "INSERT INTO session_log_events (session_id, event, subject_kind, network_id, at) VALUES (?,?,?,?,?)",
        ["s-1", "connected", "user", 1, "2026-01-01T00:00:00.000000Z"]
      )

      assert %{rows: [[nil]]} =
               SQL.query!(SmokeRepo, "SELECT old_nick FROM session_log_events", [])
    end

    test "nothing pending → a no-op migrate, and the reload still runs (idempotence)" do
      migrate_to(@old_nick_version)
      before = applied_versions()

      assert {:ok, %{migrated: [], reloaded: [Foo], failed: []}} =
               HotReload.migrate_and_reload(SmokeRepo, fn ->
                 %{reloaded: [Foo], failed: []}
               end)

      assert applied_versions() == before
    end

    test "per-module reload failures still surface after a successful migrate" do
      migrate_to(@passkeys_version)

      assert {:ok, %{migrated: [@old_nick_version], failed: [{Foo, :old_code_in_use}]}} =
               HotReload.migrate_and_reload(SmokeRepo, fn ->
                 %{reloaded: [], failed: [{Foo, :old_code_in_use}]}
               end)
    end
  end

  describe "migrate_and_reload/2 — a pending CONTRACT is refused" do
    test "names the file, migrates nothing, reloads nothing" do
      migrate_to(@totp_version)
      before = applied_versions()

      assert {:error, {:contract_migrations, [contract]}} =
               HotReload.migrate_and_reload(SmokeRepo, fn ->
                 flunk("reload must not run with a contract migration pending")
               end)

      assert Path.basename(contract) == @passkeys_file

      # The refusal is worth nothing if the DDL already went through:
      # the expand that sits BEHIND the contract must not have been
      # applied either.
      assert applied_versions() == before
      refute @passkeys_version in applied_versions()
      refute @old_nick_version in applied_versions()
      refute "old_nick" in columns("session_log_events")
    end

    test "contract_migrations/1 sees only the contract file, not the expand behind it" do
      migrate_to(@totp_version)

      assert [contract] = HotReload.contract_migrations(SmokeRepo)
      assert Path.basename(contract) == @passkeys_file

      assert [@passkeys_file, @old_nick_file] ==
               SmokeRepo |> HotReload.pending_migration_files() |> Enum.map(&Path.basename/1)
    end
  end

  describe "migrate_and_reload/2 — a failing migration aborts, for real" do
    test "the reload never runs and the failed version is not recorded" do
      migrate_to(@passkeys_version)

      # Make the pending expand fail on execution while still
      # classifying HOT: the column it adds is already there, so the
      # ALTER raises `duplicate column name`. This is the abort path
      # driven by a real migrator failure rather than a raising stub.
      SQL.query!(SmokeRepo, "ALTER TABLE session_log_events ADD COLUMN old_nick TEXT", [])

      assert_raise Exqlite.Error, ~r/duplicate column name/, fn ->
        HotReload.migrate_and_reload(SmokeRepo, fn ->
          flunk("reload must not run after a failed migration")
        end)
      end

      # The rollback claim, measured: old code is still correct because
      # the schema_migrations row was never committed, so the next
      # deploy retries the migration instead of skipping it.
      refute @old_nick_version in applied_versions()
    end
  end

  describe "migrate_and_reload/2 — at the production pool size" do
    @prod_pool_size 10

    test "one pending expand applies on a pool as wide as prod's", %{path: path} do
      # The hazard the rest of this file cannot see. Every OTHER
      # migration path in the project runs through
      # `Ecto.Migrator.with_repo/2`, which forces `pool_size: 2`. The
      # #41 handler deliberately does NOT — it uses the pool that is
      # already open, and in prod `config/runtime.exs` opens ten
      # connections (POOL_SIZE default). So the hot path is the only
      # place a migration ever meets a wide pool, and "it worked under
      # with_repo" proves nothing about it.
      migrate_to(@passkeys_version)
      refute "old_nick" in columns("session_log_events")

      stop_supervised!(SmokeRepo)
      start_pool!(path, @prod_pool_size)

      assert {:ok, %{migrated: [@old_nick_version]}} =
               HotReload.migrate_and_reload(SmokeRepo, &noop_reload/0)

      assert "old_nick" in columns("session_log_events")
      assert @old_nick_version in applied_versions()
    end

    test "a pending contract is refused at that width too", %{path: path} do
      migrate_to(@totp_version)
      before = applied_versions()

      stop_supervised!(SmokeRepo)
      start_pool!(path, @prod_pool_size)

      assert {:error, {:contract_migrations, [contract]}} =
               HotReload.migrate_and_reload(SmokeRepo, fn ->
                 flunk("reload must not run with a contract migration pending")
               end)

      assert Path.basename(contract) == @passkeys_file
      assert applied_versions() == before
    end
  end

  describe "migrate_and_reload/2 — against live readers" do
    @readers 4
    @reader_iterations 40

    test "the in-handler migrate does not starve concurrent readers into SQLITE_BUSY" do
      migrate_to(@passkeys_version)

      # The production hazard in one shape: sqlite is single-writer, and
      # the whole design rests on the DDL not blocking the live
      # Session.Servers reading and writing scrollback. If WAL +
      # busy_timeout did not cover this, a reader would come back with
      # SQLITE_BUSY and the count of errors below would be non-zero.
      readers =
        for _ <- 1..@readers do
          Task.async(fn ->
            Enum.reduce(1..@reader_iterations, [], fn _, errors ->
              try do
                SQL.query!(SmokeRepo, "SELECT COUNT(*) FROM session_log_events", [])
                errors
              rescue
                e -> [e | errors]
              end
            end)
          end)
        end

      assert {:ok, %{migrated: [@old_nick_version]}} =
               HotReload.migrate_and_reload(SmokeRepo, &noop_reload/0)

      errors = readers |> Task.await_many(30_000) |> List.flatten()

      assert errors == [],
             "#{length(errors)} reader queries failed during the in-handler migrate: " <>
               inspect(Enum.take(errors, 3))

      assert "old_nick" in columns("session_log_events")
    end
  end
end
