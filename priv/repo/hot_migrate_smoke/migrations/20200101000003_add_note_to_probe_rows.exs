defmodule Grappa.HotMigrateSmoke.Migrations.AddNoteToProbeRows do
  @moduledoc """
  Fixture 3 of 3 for `test/grappa/migrations/hot_deploy_migrate_test.exs`.
  Never runs against `Grappa.Repo` — see `../README.md`.

  The EXPAND anchor, and the last file in the set: an additive nullable
  column, which is the shape whose crash window is zero and which the
  hot handler is allowed to apply under a live BEAM.
  """
  use Ecto.Migration

  def change do
    alter table(:probe_rows) do
      add :note, :string
    end
  end
end
