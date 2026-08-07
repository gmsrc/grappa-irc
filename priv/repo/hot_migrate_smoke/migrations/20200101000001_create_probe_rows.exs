defmodule Grappa.HotMigrateSmoke.Migrations.CreateProbeRows do
  @moduledoc """
  Fixture 1 of 3 for `test/grappa/migrations/hot_deploy_migrate_test.exs`.
  Never runs against `Grappa.Repo` — see `../README.md`.

  The BASE every scenario migrates to first. `label` is `null: false` so
  the old-code INSERT the expand fixture is asserted against has a column
  it is actually obliged to supply.

  Classifies HOT (`create table`), but nothing depends on that: this file
  is applied by an explicit `migrate_to/1`, never left pending.
  """
  use Ecto.Migration

  def change do
    create table(:probe_rows) do
      add :label, :string, null: false
    end
  end
end
