defmodule Grappa.Migrations.SwapNickservPassSlotForServerPassTest do
  @moduledoc """
  GH #1044 — the CONTRACT step (`20260810120000_swap_nickserv_pass_slot_for_server_pass`).

  #124 retired `nickserv_pass_encrypted` expand-only: nothing read or wrote it,
  but the column stayed. This migration drops it and adds an EMPTY
  `server_pass_encrypted` in the same cold window.

  ## Two questions, and only one of them is about the shape

  The shape assertions below read the real migrated schema (`PRAGMA
  table_info`) rather than the Ecto struct: the struct reports exactly what the
  schema module declares, which is the thing under test.

  Shape alone cannot tell the chosen design from the rejected one. A
  `RENAME COLUMN nickserv_pass_encrypted TO server_pass_encrypted` leaves the
  identical set of column names behind, and the moduledoc rules it out for a
  reason that is invisible from there: the old bytes would ride across and a
  NickServ secret would be relabelled as a server `PASS`. Measured, not
  assumed — with `up/0` replaced by that one `rename`, the three shape tests
  stayed green. So the second describe drives the real migration over a row
  that actually CARRIES the retired secret, which is the only place the two
  designs differ.

  `async: false` because that second describe issues DDL: it rewinds
  `network_credentials` to its pre-#1044 shape and replays the swap forwards.
  The sandbox transaction rolls both back, but a table shape is not per-test
  state the way rows are, and a concurrent case reading that table has no
  business meeting it mid-rewind.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Repo

  # Matched by SUFFIX, not by version: the version is renumbered whenever this
  # branch lands behind another migration, and a stale literal here would make
  # `Ecto.Migrator.down/4` return `:already_down` — a test that rewinds nothing
  # and then asserts against the untouched schema.
  @migration_glob "priv/repo/migrations/*_swap_nickserv_pass_slot_for_server_pass.exs"

  # A NickServ ciphertext, as the column really holds it: an opaque Cloak BLOB.
  # Nothing here decrypts it — the migration is pure DDL — so its only job is to
  # be recognisable on the other side of the swap.
  @retired_secret <<"cloak-blob-nickserv-1044">>
  @kept_secret <<"cloak-blob-password-1044">>

  defp columns do
    %{rows: rows} = Repo.query!("PRAGMA table_info(network_credentials)")
    MapSet.new(rows, fn row -> Enum.at(row, 1) end)
  end

  describe "the network_credentials secret slots after the swap" do
    test "the retired nickserv_pass_encrypted column is GONE" do
      refute MapSet.member?(columns(), "nickserv_pass_encrypted")
    end

    test "the server PASS slot exists, and the NickServ slot is left where it was" do
      cols = columns()

      assert MapSet.member?(cols, "server_pass_encrypted")
      # The direction #1044 fixed: `password_encrypted` KEEPS the NickServ
      # meaning, because on every visitor row that is what it holds.
      assert MapSet.member?(cols, "password_encrypted")
    end
  end

  describe "the swap driven over a row that really carries the retired secret" do
    setup do
      user = user_fixture()
      {network, _} = network_with_server(port: 6667)
      %{credential: credential_fixture(user, network, %{})}
    end

    # The row is staged through the migration's OWN `down/0` rather than a
    # stand-in table: `down/0` restores exactly the pre-#1044 shape, so what
    # `up/0` then meets is the real `network_credentials`, with its real
    # constraints and a real credential row in it. A hand-built table would
    # prove something about the table, not about the migration.
    #
    # Everything between the rewind and the replay is raw SQL on purpose:
    # `Credential` declares the post-#1044 columns, so loading it against the
    # rewound schema would fail for a reason that has nothing to do with the
    # claim.
    test "the retired secret is DESTROYED, not relabelled as the server PASS", %{
      credential: credential
    } do
      module = load_migration!()
      version = migration_version!()

      assert :ok = Ecto.Migrator.down(Repo, version, module, log: false)

      Repo.query!(
        "UPDATE network_credentials SET nickserv_pass_encrypted = ?, password_encrypted = ? WHERE id = ?",
        [@retired_secret, @kept_secret, credential.id]
      )

      assert :ok = Ecto.Migrator.up(Repo, version, module, log: false)

      # The match is the first claim: a DROP + ADD rewrites the table, and a row
      # that does not come out the other side is a data loss no shape assertion
      # would ever see.
      assert %{rows: [[server_pass, password]]} =
               Repo.query!(
                 "SELECT server_pass_encrypted, password_encrypted FROM network_credentials WHERE id = ?",
                 [credential.id]
               )

      # The claim the whole migration exists to make, and the one a RENAME
      # breaks: the new slot is empty even where the old one was full.
      assert is_nil(server_pass)

      # The direction. Renaming `password_encrypted` instead would satisfy every
      # other assertion in this file while emptying the column that holds the
      # NickServ secret on the whole visitor population.
      assert password == @kept_secret
    end
  end

  # `priv/repo/migrations/*.exs` is not compiled into the app — the migrator
  # loads it at run time — so the module has to be required before it can be
  # named.
  defp load_migration! do
    Code.require_file(migration_file!())
    Grappa.Repo.Migrations.SwapNickservPassSlotForServerPass
  end

  defp migration_file! do
    [path] = File.cwd!() |> Path.join(@migration_glob) |> Path.wildcard()
    path
  end

  defp migration_version! do
    migration_file!() |> Path.basename() |> String.split("_", parts: 2) |> hd() |> String.to_integer()
  end
end
