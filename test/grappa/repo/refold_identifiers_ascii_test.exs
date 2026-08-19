defmodule Grappa.Repo.Migrations.RefoldIdentifiersAsciiTest do
  @moduledoc """
  #525 — the re-fold migration's collision guard. The migration narrows
  every identifier index from rfc1459 to ASCII; recreating a UNIQUE index
  with the narrower fold can never collide on data that was unique under
  the wider rfc1459 fold (proven + measured zero on prod), but a drifted
  DB could hide a masked pair. Policy: **detect and fail LOUD, never
  guess/un-merge**. This pins that behaviour.

  `async: false` — the collision test drops a UNIQUE index inside the
  sandbox transaction to seed a colliding pair; keeping it serial avoids
  any cross-test schema interference on the shared SQLite file.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.QueryWindows.Window
  alias Grappa.Repo

  @migration Grappa.Repo.Migrations.RefoldIdentifiersAscii
  @migration_path "priv/repo/migrations/20260729120000_refold_identifiers_ascii.exs"
  @qw_user_index "query_windows_user_network_nick_folded_index"

  setup_all do
    # The migrator loads migration modules when it sets up the test DB, but
    # don't depend on that — ensure the module is available for direct calls.
    unless Code.ensure_loaded?(@migration), do: Code.require_file(@migration_path)
    :ok
  end

  defp now, do: DateTime.truncate(DateTime.utc_now(), :second)

  describe "refuse_on_collision!/1" do
    test "returns :ok on clean data (the prod case — narrower fold can't collide)" do
      user = user_fixture()
      net = network_fixture()

      # Two genuinely distinct nicks that also stay distinct under ASCII.
      {:ok, _} = Grappa.QueryWindows.open({:user, user.id}, net.id, "Alice", user.name)
      {:ok, _} = Grappa.QueryWindows.open({:user, user.id}, net.id, "Bob", user.name)

      assert apply(@migration, :refuse_on_collision!, [Repo]) == :ok
    end

    test "raises LOUD on an ASCII-fold collision and NEVER deletes a row (#525 no-guess)" do
      user = user_fixture()
      net = network_fixture()

      # Drop the enforcing UNIQUE index so a masked collision can exist —
      # this simulates a drifted / hand-edited DB. `Foo` and `foo` fold to
      # the SAME ASCII key `foo` (they differ only in case), which the
      # rfc1459 index would ALSO have merged, so the only way to have both
      # rows is with the index absent. insert_all bypasses open/4's
      # idempotent re-select (which would otherwise dedup them).
      Repo.query!("DROP INDEX IF EXISTS #{@qw_user_index}")

      {2, _} =
        Repo.insert_all(Window, [
          %{
            user_id: user.id,
            network_id: net.id,
            target_nick: "Foo",
            opened_at: now(),
            inserted_at: now(),
            updated_at: now()
          },
          %{
            user_id: user.id,
            network_id: net.id,
            target_nick: "foo",
            opened_at: now(),
            inserted_at: now(),
            updated_at: now()
          }
        ])

      assert_raise RuntimeError, ~r/ASCII-fold collision/, fn ->
        apply(@migration, :refuse_on_collision!, [Repo])
      end

      # No-guess proof: both colliding rows are STILL present — the guard
      # aborts, it does not pick a "loser" to delete.
      surviving = from(w in Window, where: w.user_id == ^user.id)
      assert Repo.aggregate(surviving, :count) == 2
    end

    test "ascii_collisions/1 pinpoints the colliding branch + folded key" do
      user = user_fixture()
      net = network_fixture()

      Repo.query!("DROP INDEX IF EXISTS #{@qw_user_index}")

      {2, _} =
        Repo.insert_all(Window, [
          %{
            user_id: user.id,
            network_id: net.id,
            target_nick: "Nick[1]",
            opened_at: now(),
            inserted_at: now(),
            updated_at: now()
          },
          %{
            user_id: user.id,
            network_id: net.id,
            target_nick: "nick[1]",
            opened_at: now(),
            inserted_at: now(),
            updated_at: now()
          }
        ])

      collisions = apply(@migration, :ascii_collisions, [Repo])

      assert Enum.any?(collisions, fn {table, col, _, row} ->
               table == "query_windows" and col == "target_nick" and "nick[1]" in row
             end),
             "expected a query_windows.target_nick collision on the folded key nick[1], got: #{inspect(collisions)}"
    end
  end
end
