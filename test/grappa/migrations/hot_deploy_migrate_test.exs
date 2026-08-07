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

  ## The three anchors, and why the fixture owns them

  The set under test is `priv/repo/hot_migrate_smoke/migrations` — three
  files this test owns, not the project's own migration set:

    * `20200101000001_create_probe_rows` — the BASE every scenario
      migrates to first.
    * `20200101000002_add_probe_rows_label_unique_index` — COLD.
    * `20200101000003_add_note_to_probe_rows` — HOT, and last, so each
      scenario has exactly ONE pending file and the assertions name it.

  This file originally read the project's set and hardcoded its last
  three versions as the anchors. That coupled every assertion here to
  the repo's migration count: `#124` added one migration and all 14
  tests went red, and so would every future PR that adds one. "Nothing
  unapplied → empty" is a legitimate thing to assert, but only about a
  set the test controls — hence a `priv` of its own (see that
  directory's README for why it sits under `priv/repo/`).
  """

  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL
  alias Grappa.Deploy.Preflight
  alias Grappa.HotMigrateSmokeRepo, as: SmokeRepo
  alias Grappa.HotReload

  @fixture_priv "priv/repo/hot_migrate_smoke"

  @base_version 20_200_101_000_001
  @contract_version 20_200_101_000_002
  @expand_version 20_200_101_000_003

  @contract_file "20200101000002_add_probe_rows_label_unique_index.exs"
  @expand_file "20200101000003_add_note_to_probe_rows.exs"

  setup do
    path =
      Path.join(System.tmp_dir!(), "grappa-hot-migrate-#{System.unique_integer([:positive])}.db")

    # An explicit `priv` is load-bearing twice over. Without any, Ecto
    # derives the migrations dir from the REPO NAME
    # (priv/hot_migrate_smoke_repo) and `Ecto.Migrator.migrations_path/1`
    # — which the production code under test calls — resolves somewhere
    # empty. With `priv: "priv/repo"`, as this fixture first had, the
    # path resolution IS exercised but the SET is whatever the project
    # happens to ship that day, which is the coupling the moduledoc
    # describes. A `priv` of the fixture's own exercises the identical
    # resolution against a set that cannot drift.
    #
    # `pool_size: 2` is what every migration path in the project already
    # runs at — `Ecto.Migrator.with_repo/2` forces it — and the cases
    # that care about width restart the pool themselves, below. It is no
    # longer a constraint: the measured 10/10 red at `pool_size: 5` was a
    # property of replaying the project's ~80-migration graph onto an
    # empty file, which this fixture no longer does (DESIGN_NOTES
    # 2026-08-07, #41 — the scope claim, N=300). Dropping that replay
    # also stops these 14 tests from recompiling ~80 migration modules
    # apiece, which is what pushes a repeated run into the `module_code`
    # table ceiling.
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
      priv: @fixture_priv,
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

  # Reads `table`'s columns from `pool_size` connections held open AT THE
  # SAME TIME, and returns one column list per connection.
  #
  # The simultaneity is the whole point and it is enforced, not hoped
  # for: nothing is released until every holder has reported in, and a
  # connection cannot sit inside two transactions at once, so N
  # concurrent holders are N distinct connections. A pool that could not
  # serve them all fails the `assert_receive` instead of quietly
  # measuring less. Without this, a wide-pool test can pass by reading
  # back through the very connection the migrator wrote on — which is
  # not the question a wide pool asks.
  defp columns_from_every_connection(table, pool_size) do
    parent = self()

    holders = for _ <- 1..pool_size, do: Task.async(fn -> hold_then_read(parent, table) end)

    held =
      for _ <- 1..pool_size do
        assert_receive {:holding, pid}, 30_000
        pid
      end

    Enum.each(held, &send(&1, :release))
    Task.await_many(holders, 30_000)
  end

  defp hold_then_read(parent, table) do
    {:ok, cols} =
      SmokeRepo.transaction(fn ->
        send(parent, {:holding, self()})
        receive do: (:release -> :ok)
        columns(table)
      end)

    cols
  end

  describe "the fixture's own migration set" do
    # Every other test here says "exactly one pending file" or "nothing
    # unapplied", which are statements about THIS set — so the set is
    # part of the contract, and a fourth file silently changes what all
    # of them measure. This is where that shows up as a named failure
    # instead of a confusing one. The two classifications are pinned for
    # the same reason: if the contract anchor ever classified HOT, the
    # refusal scenarios would pass while measuring nothing.
    test "is exactly base, contract, expand — and the classifier agrees on the last two" do
      dir = Ecto.Migrator.migrations_path(SmokeRepo)

      assert [_, contract, expand] =
               dir |> Path.join("*.exs") |> Path.wildcard() |> Enum.sort()

      assert Path.basename(contract) == @contract_file
      assert Path.basename(expand) == @expand_file

      assert Preflight.classify_migration(File.read!(contract)) == :cold
      assert Preflight.classify_migration(File.read!(expand)) == :hot
    end
  end

  describe "pending_migration_files/1 against a live pool" do
    test "resolves the real migrations dir and names exactly what is unapplied" do
      migrate_to(@contract_version)

      assert [path] = HotReload.pending_migration_files(SmokeRepo)
      assert Path.basename(path) == @expand_file
      assert File.exists?(path)
    end

    test "nothing unapplied → empty" do
      migrate_to(@expand_version)
      assert [] = HotReload.pending_migration_files(SmokeRepo)
    end
  end

  describe "migrate_and_reload/2 — a pending EXPAND is applied for real" do
    test "the column does not exist, then it does, and the reload sees it already there" do
      migrate_to(@contract_version)
      refute "note" in columns("probe_rows")

      # The probe runs where the module reload runs. Asserting the new
      # column from INSIDE it is the ordering claim measured rather than
      # asserted: if the reload ran first, this read would fail.
      parent = self()

      probe = fn ->
        send(parent, {:columns_at_reload, columns("probe_rows")})
        noop_reload()
      end

      assert {:ok, %{migrated: [@expand_version], reloaded: [], failed: []}} =
               HotReload.migrate_and_reload(SmokeRepo, probe)

      assert_received {:columns_at_reload, at_reload}
      assert "note" in at_reload

      assert "note" in columns("probe_rows")
      assert @expand_version in applied_versions()
    end

    test "an old-code INSERT that omits the new column still lands — the expand claim itself" do
      migrate_to(@contract_version)
      assert {:ok, _} = HotReload.migrate_and_reload(SmokeRepo, &noop_reload/0)

      # Exactly the write shape the still-loaded old code performs: every
      # column it knew about, and nothing else. If this raised, "expand
      # has a zero crash window" would be false.
      SQL.query!(SmokeRepo, "INSERT INTO probe_rows (label) VALUES (?)", ["l-1"])

      assert %{rows: [[nil]]} = SQL.query!(SmokeRepo, "SELECT note FROM probe_rows", [])
    end

    test "nothing pending → a no-op migrate, and the reload still runs (idempotence)" do
      migrate_to(@expand_version)
      before = applied_versions()

      assert {:ok, %{migrated: [], reloaded: [Foo], failed: []}} =
               HotReload.migrate_and_reload(SmokeRepo, fn ->
                 %{reloaded: [Foo], failed: []}
               end)

      assert applied_versions() == before
    end

    test "per-module reload failures still surface after a successful migrate" do
      migrate_to(@contract_version)

      assert {:ok, %{migrated: [@expand_version], failed: [{Foo, :old_code_in_use}]}} =
               HotReload.migrate_and_reload(SmokeRepo, fn ->
                 %{reloaded: [], failed: [{Foo, :old_code_in_use}]}
               end)
    end
  end

  describe "migrate_and_reload/2 — a pending CONTRACT is refused" do
    test "names the file, migrates nothing, reloads nothing" do
      migrate_to(@base_version)
      before = applied_versions()

      assert {:error, {:contract_migrations, [contract]}} =
               HotReload.migrate_and_reload(SmokeRepo, fn ->
                 flunk("reload must not run with a contract migration pending")
               end)

      assert Path.basename(contract) == @contract_file

      # The refusal is worth nothing if the DDL already went through:
      # the expand that sits BEHIND the contract must not have been
      # applied either.
      assert applied_versions() == before
      refute @contract_version in applied_versions()
      refute @expand_version in applied_versions()
      refute "note" in columns("probe_rows")
    end

    test "contract_migrations/1 sees only the contract file, not the expand behind it" do
      migrate_to(@base_version)

      assert [contract] = HotReload.contract_migrations(SmokeRepo)
      assert Path.basename(contract) == @contract_file

      assert [@contract_file, @expand_file] ==
               SmokeRepo |> HotReload.pending_migration_files() |> Enum.map(&Path.basename/1)
    end
  end

  describe "migrate_and_reload/2 — a failing migration aborts, for real" do
    test "the reload never runs and the failed version is not recorded" do
      migrate_to(@contract_version)

      # Make the pending expand fail on execution while still
      # classifying HOT: the column it adds is already there, so the
      # ALTER raises `duplicate column name`. This is the abort path
      # driven by a real migrator failure rather than a raising stub.
      SQL.query!(SmokeRepo, "ALTER TABLE probe_rows ADD COLUMN note TEXT", [])

      assert_raise Exqlite.Error, ~r/duplicate column name/, fn ->
        HotReload.migrate_and_reload(SmokeRepo, fn ->
          flunk("reload must not run after a failed migration")
        end)
      end

      # The rollback claim, measured: old code is still correct because
      # the schema_migrations row was never committed, so the next
      # deploy retries the migration instead of skipping it.
      refute @expand_version in applied_versions()
    end
  end

  describe "migrate_and_reload/2 — at wide pool sizes" do
    # The hazard the rest of this file cannot see. Every OTHER migration
    # path in the project runs through `Ecto.Migrator.with_repo/2`, which
    # forces `pool_size: 2`. The #41 handler deliberately does NOT — it
    # uses the pool that is already open, and in prod
    # `config/runtime.exs` opens ten connections (POOL_SIZE default). So
    # the hot path is the only place a migration ever meets a wide pool,
    # and "it worked under with_repo" proves nothing about it.
    #
    # Both widths, not just prod's: 5 is the narrowest width at which the
    # WHOLE-GRAPH replay is measured red (see the setup comment), so if
    # the single-pending regime shared that hazard, 5 is where it would
    # show first. It does not — which is the scope claim #41 rests on,
    # and the reason the graph-replay red can be recorded as a limit
    # outside the handler's regime instead of blocking it.
    @wide_pool_sizes [5, 10]

    for pool_size <- @wide_pool_sizes do
      test "one pending expand applies on a #{pool_size}-wide pool, and every connection sees it",
           %{path: path} do
        pool_size = unquote(pool_size)

        migrate_to(@contract_version)
        refute "note" in columns("probe_rows")

        stop_supervised!(SmokeRepo)
        start_pool!(path, pool_size)

        assert {:ok, %{migrated: [@expand_version]}} =
                 HotReload.migrate_and_reload(SmokeRepo, &noop_reload/0)

        assert "note" in columns("probe_rows")
        assert @expand_version in applied_versions()

        # The observed graph-replay failure is a later statement not
        # seeing an earlier migration's column. With one pending file
        # there is no later migration, so the only place that shape can
        # still hide is a pool connection that missed the DDL — read
        # every one of them.
        for seen <- columns_from_every_connection("probe_rows", pool_size) do
          assert "note" in seen
        end
      end

      test "a pending contract is refused on a #{pool_size}-wide pool too", %{path: path} do
        migrate_to(@base_version)
        before = applied_versions()

        stop_supervised!(SmokeRepo)
        start_pool!(path, unquote(pool_size))

        assert {:error, {:contract_migrations, [contract]}} =
                 HotReload.migrate_and_reload(SmokeRepo, fn ->
                   flunk("reload must not run with a contract migration pending")
                 end)

        assert Path.basename(contract) == @contract_file
        assert applied_versions() == before
      end
    end
  end

  describe "migrate_and_reload/2 — against live readers" do
    @readers 4
    @reader_iterations 40

    test "the in-handler migrate does not starve concurrent readers into SQLITE_BUSY" do
      migrate_to(@contract_version)

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
                SQL.query!(SmokeRepo, "SELECT COUNT(*) FROM probe_rows", [])
                errors
              rescue
                e -> [e | errors]
              end
            end)
          end)
        end

      assert {:ok, %{migrated: [@expand_version]}} =
               HotReload.migrate_and_reload(SmokeRepo, &noop_reload/0)

      errors = readers |> Task.await_many(30_000) |> List.flatten()

      assert errors == [],
             "#{length(errors)} reader queries failed during the in-handler migrate: " <>
               inspect(Enum.take(errors, 3))

      assert "note" in columns("probe_rows")
    end
  end
end
