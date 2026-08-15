defmodule Grappa.DuplicateVersionSmoke.Migrations.FirstClaimOnTheVersion do
  @moduledoc """
  Fixture 1 of 2 for `test/grappa/migrations/duplicate_version_gate_test.exs`.
  Never compiled, never applied — see `../README.md`.

  Half of a deliberate version collision. The sibling
  `20200101000001_second_claim_on_the_version.exs` claims the same
  number, which is what #1044 and #1038 did to `20260810120000`.
  """
  use Ecto.Migration

  def change do
    create table(:first_claim_rows) do
      add :label, :string
    end
  end
end
