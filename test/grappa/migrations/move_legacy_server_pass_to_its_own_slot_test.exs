defmodule Grappa.Migrations.MoveLegacyServerPassToItsOwnSlotTest do
  @moduledoc """
  GH #1044 — the DATA step that makes the read cutover safe.

  The sibling migration (`*_swap_nickserv_pass_slot_for_server_pass`) opened
  `server_pass_encrypted` EMPTY. Every `:server_pass` row written before that
  therefore still keeps its gate secret in `password_encrypted`, which is the
  column #1044 hands to the NickServ role. The moment `AuthFSM` starts reading
  the PASS token from the new slot, those rows send nothing and their
  handshake is refused.

  A read-side fallback onto the old column would paper over it and is exactly
  what #124's one-home-per-role property forbids, so the bytes move ONCE,
  here, and every reader afterwards has a single place to look.

  ## The claim that is easy to get wrong

  The move is a raw SQL column-to-column copy of a Cloak ciphertext. That is
  only sound if the ciphertext carries no per-column binding, and the test
  below drives the value back out through the SCHEMA (which decrypts on load)
  rather than comparing blobs: comparing blobs would pass just as happily if
  the result were undecryptable garbage.

  `async: false` for the same reason as its sibling: the second describe
  issues DDL-adjacent rewinds of a shared table.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Networks.Credential
  alias Grappa.Repo

  # Matched by SUFFIX, not by version — a rebase renumbers the file and a stale
  # literal would make `Ecto.Migrator.down/4` answer `:already_down`, i.e. a
  # test that rewinds nothing and then asserts against an untouched table.
  @migration_glob "priv/repo/migrations/*_move_legacy_server_pass_to_its_own_slot.exs"

  defp secrets(id) do
    %{rows: [[server_pass, password]]} =
      Repo.query!(
        "SELECT server_pass_encrypted, password_encrypted FROM network_credentials WHERE id = ?",
        [id]
      )

    {server_pass, password}
  end

  # Stage a PRE-#1044 row: the gate secret sitting in the NickServ column,
  # the new slot empty. Written through the schema so the value is a REAL
  # Cloak ciphertext, then moved across by raw SQL — which is what the
  # migration does, and the only way the decryptability claim means anything.
  defp legacy_server_pass_row(user, network, secret) do
    {:ok, cred} =
      %Credential{}
      |> Credential.changeset(%{
        user_id: user.id,
        network_id: network.id,
        nick: "vjt",
        auth_method: :server_pass,
        server_pass: secret
      })
      |> Repo.insert()

    {slot, _} = secrets(cred.id)

    Repo.query!(
      "UPDATE network_credentials SET password_encrypted = ?, server_pass_encrypted = NULL WHERE id = ?",
      [slot, cred.id]
    )

    cred
  end

  # The test database is migrated at setup, so the version is already in
  # `schema_migrations` and a bare `up/2` answers `:already_up` — a call that
  # runs nothing and then asserts against untouched rows. Rewind first, then
  # replay forwards over the staged row, exercising the real migrator path.
  #
  # The rewind is a no-op on every fixture in this file BY THE PREDICATE, not
  # by luck: `down/0` only matches (slot set, password NULL), and none of the
  # staged rows are in that shape until `up/0` has run.
  defp run_migration! do
    assert :ok = Ecto.Migrator.down(Repo, migration_version!(), load_migration!(), log: false)
    assert :ok = Ecto.Migrator.up(Repo, migration_version!(), load_migration!(), log: false)
  end

  setup do
    user = user_fixture()
    {network, _} = network_with_server(port: 6667)
    %{user: user, network: network}
  end

  describe "the legacy row" do
    test "the gate secret MOVES to its own slot and leaves the NickServ one empty", ctx do
      cred = legacy_server_pass_row(ctx.user, ctx.network, "gate-secret")

      run_migration!()

      {slot, password} = secrets(cred.id)

      refute is_nil(slot)
      assert is_nil(password)
    end

    test "the moved bytes still DECRYPT — the ciphertext is not column-bound", ctx do
      cred = legacy_server_pass_row(ctx.user, ctx.network, "gate-secret")

      run_migration!()

      # Through the schema, not the blob: a raw-blob comparison would be green
      # on an undecryptable value, which is the failure this guards.
      assert Credential.upstream_server_pass(Repo.get!(Credential, cred.id)) == "gate-secret"
    end

    test "running it twice moves nothing further (idempotent)", ctx do
      cred = legacy_server_pass_row(ctx.user, ctx.network, "gate-secret")

      run_migration!()
      after_first = secrets(cred.id)

      assert :already_up =
               Ecto.Migrator.up(Repo, migration_version!(), load_migration!(), log: false)

      assert secrets(cred.id) == after_first
    end
  end

  describe "what the move must NOT touch" do
    test "a :nickserv_identify row keeps its secret where it is", ctx do
      {:ok, cred} =
        %Credential{}
        |> Credential.changeset(%{
          user_id: ctx.user.id,
          network_id: ctx.network.id,
          nick: "vjt",
          auth_method: :nickserv_identify,
          password: "ns-secret"
        })
        |> Repo.insert()

      run_migration!()

      {slot, _} = secrets(cred.id)

      assert is_nil(slot)
      assert Credential.upstream_password(Repo.get!(Credential, cred.id)) == "ns-secret"
    end

    # The row shape #1044 exists to produce: a gate secret AND a NickServ one,
    # already in their right homes. The migration must recognise it as done
    # and not overwrite the NickServ secret with a copy of the gate one.
    test "a row already carrying BOTH secrets is left exactly as it is", ctx do
      {:ok, cred} =
        %Credential{}
        |> Credential.changeset(%{
          user_id: ctx.user.id,
          network_id: ctx.network.id,
          nick: "vjt",
          auth_method: :server_pass,
          password: "ns-secret",
          server_pass: "gate-secret"
        })
        |> Repo.insert()

      run_migration!()

      reloaded = Repo.get!(Credential, cred.id)

      assert Credential.upstream_server_pass(reloaded) == "gate-secret"
      assert Credential.upstream_password(reloaded) == "ns-secret"
    end

    # A visitor's `auth_method` is DERIVED from the presence of its one secret
    # and never reaches `:server_pass`, so no visitor row is in scope. The
    # `user_id IS NOT NULL` conjunct is the belt: if a future write path ever
    # produced such a row, moving its secret would silently un-identify the
    # visitor.
    test "a visitor row is out of scope", ctx do
      visitor = visitor_fixture(nick: "guest1", network_slug: ctx.network.slug)

      {:ok, _} =
        Grappa.Networks.Credentials.commit_visitor_password(
          visitor.id,
          ctx.network.id,
          "ns-secret"
        )

      run_migration!()

      {:ok, cred} = Grappa.Networks.Credentials.get_visitor_credential(visitor.id, ctx.network.id)

      {slot, _} = secrets(cred.id)

      assert is_nil(slot)
      assert Credential.recover_secret(cred) == "ns-secret"
    end
  end

  defp load_migration! do
    Code.require_file(migration_file!())
    Grappa.Repo.Migrations.MoveLegacyServerPassToItsOwnSlot
  end

  defp migration_file! do
    [path] = File.cwd!() |> Path.join(@migration_glob) |> Path.wildcard()
    path
  end

  defp migration_version! do
    migration_file!()
    |> Path.basename()
    |> String.split("_", parts: 2)
    |> hd()
    |> String.to_integer()
  end
end
