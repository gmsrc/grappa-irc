defmodule Grappa.DuplicateVersionSmoke.Migrations.SecondClaimOnTheVersion do
  @moduledoc """
  Fixture 2 of 2 for `test/grappa/migrations/duplicate_version_gate_test.exs`.
  Never compiled, never applied — see `../README.md`.

  The other half of the collision. On a database that has already
  applied `20200101000001`, BOTH files leave the pending set and neither
  ever runs — the silent regime #1348 closes.
  """
  use Ecto.Migration

  def change do
    create table(:second_claim_rows) do
      add :label, :string
    end
  end
end
