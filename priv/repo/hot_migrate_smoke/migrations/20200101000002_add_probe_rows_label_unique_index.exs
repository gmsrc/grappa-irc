defmodule Grappa.HotMigrateSmoke.Migrations.AddProbeRowsLabelUniqueIndex do
  @moduledoc """
  Fixture 2 of 3 for `test/grappa/migrations/hot_deploy_migrate_test.exs`.
  Never runs against `Grappa.Repo` — see `../README.md`.

  The CONTRACT anchor. `create unique_index` on a table a PREVIOUS
  migration created is contract by `Grappa.Deploy.Preflight`'s stated
  rule: a write that was legal before can start failing, and a duplicate
  already in the table fails the DDL. The widened same-body exception
  (`create table` + `create unique_index` in one migration) deliberately
  does not reach here.

  Chosen over a `remove` because it applies cleanly on every sqlite the
  project supports, and the scenarios that sit BEHIND the contract have
  to apply it for real.
  """
  use Ecto.Migration

  def change do
    create unique_index(:probe_rows, [:label])
  end
end
