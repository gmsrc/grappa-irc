defmodule Grappa.Networks.PerformChangesetTest do
  @moduledoc """
  #189 — the on-connect perform list + `$oper_pass` secret live on the
  credential, encrypted at rest (Cloak AES-GCM, `EncryptedBinary
  redact: true`) exactly like `password_encrypted`. `perform_changeset/2`
  is the narrow write path the per-network REST editor drives; it casts
  the two virtual inputs, encrypts them, and touches nothing else (mirror
  of `password_changeset/2` / `last_joined_channels_changeset/2`).

  Async-safe: each test sets up a unique user/network pair via fixtures.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.Credential
  alias Grappa.Repo

  defp setup_credential(attrs \\ %{}) do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: 6667, slug: "test-#{System.unique_integer([:positive])}")

    cred =
      credential_fixture(
        user,
        network,
        Map.merge(%{auth_method: :nickserv_identify, password: "oldpass"}, attrs)
      )

    {user, network, cred}
  end

  defp reload(%Credential{} = cred) do
    Repo.get_by!(Credential, user_id: cred.user_id, network_id: cred.network_id)
  end

  describe "Credential.perform_changeset/2" do
    test "encrypts + round-trips perform_list, oper_pass and nickserv_pass on read (Cloak decrypt)" do
      {_, _, cred} = setup_credential()

      cs =
        Credential.perform_changeset(cred, %{
          perform_list: "NS IDENTIFY $nickserv_pass\nOPER vjt $oper_pass",
          oper_pass: "hunter2",
          nickserv_pass: "nspass"
        })

      assert cs.valid?
      {:ok, saved} = Repo.update(cs)
      reloaded = reload(saved)

      # After Cloak :load, the *_encrypted fields carry the DECRYPTED plaintext.
      assert reloaded.perform_list_encrypted ==
               "NS IDENTIFY $nickserv_pass\nOPER vjt $oper_pass"

      assert reloaded.oper_pass_encrypted == "hunter2"
      assert reloaded.nickserv_pass_encrypted == "nspass"
    end

    test "accessors return the decrypted plaintext, nil when unset" do
      {_, _, cred} = setup_credential()

      {:ok, saved} =
        cred
        |> Credential.perform_changeset(%{
          perform_list: "MODE $nick +x",
          oper_pass: "s3cr3t",
          nickserv_pass: "nspass"
        })
        |> Repo.update()

      reloaded = reload(saved)
      assert Credential.perform_list_text(reloaded) == "MODE $nick +x"
      assert Credential.upstream_oper_pass(reloaded) == "s3cr3t"
      assert Credential.upstream_nickserv_pass(reloaded) == "nspass"

      {_, _, bare} = setup_credential()
      assert Credential.perform_list_text(bare) == nil
      assert Credential.upstream_oper_pass(bare) == nil
      assert Credential.upstream_nickserv_pass(bare) == nil
    end

    test "inspect/1 never leaks perform_list, oper_pass or nickserv_pass (redact: true)" do
      {_, _, cred} = setup_credential()

      {:ok, saved} =
        cred
        |> Credential.perform_changeset(%{
          perform_list: "OPER vjt topsecret",
          oper_pass: "leakme",
          nickserv_pass: "nsleakme"
        })
        |> Repo.update()

      dump = inspect(reload(saved))
      refute dump =~ "topsecret"
      refute dump =~ "leakme"
      refute dump =~ "nsleakme"
    end

    test "a multi-line perform list is accepted (newlines are the line separator)" do
      {_, _, cred} = setup_credential()

      cs =
        Credential.perform_changeset(cred, %{
          perform_list: "# comment\nNS IDENTIFY $nickserv_pass\n\nMODE $nick +x\n"
        })

      assert cs.valid?
    end

    test "clearing perform_list / oper_pass / nickserv_pass with empty string stores nil" do
      {_, _, cred} = setup_credential()

      {:ok, saved} =
        cred
        |> Credential.perform_changeset(%{
          perform_list: "MODE $nick +x",
          oper_pass: "x",
          nickserv_pass: "ns"
        })
        |> Repo.update()

      {:ok, cleared} =
        saved
        |> Credential.perform_changeset(%{perform_list: "", oper_pass: "", nickserv_pass: ""})
        |> Repo.update()

      reloaded = reload(cleared)
      assert Credential.perform_list_text(reloaded) == nil
      assert Credential.upstream_oper_pass(reloaded) == nil
      assert Credential.upstream_nickserv_pass(reloaded) == nil
    end

    test "omitting nickserv_pass keeps the stored secret (leave-blank-to-keep)" do
      {_, _, cred} = setup_credential()

      {:ok, saved} =
        cred
        |> Credential.perform_changeset(%{nickserv_pass: "keepme"})
        |> Repo.update()

      # A later edit that touches ONLY the perform list must not disturb the
      # stored nickserv secret (get_change == nil → keep-branch).
      {:ok, updated} =
        saved
        |> Credential.perform_changeset(%{perform_list: "MODE $nick +x"})
        |> Repo.update()

      reloaded = reload(updated)
      assert Credential.perform_list_text(reloaded) == "MODE $nick +x"
      assert Credential.upstream_nickserv_pass(reloaded) == "keepme"
    end

    test "rejects a NUL byte in perform_list" do
      {_, _, cred} = setup_credential()
      cs = Credential.perform_changeset(cred, %{perform_list: "MODE $nick +x\0evil"})
      refute cs.valid?
      assert %{perform_list: [_ | _]} = errors_on(cs)
    end

    test "rejects CR/LF/NUL in oper_pass (single-line secret)" do
      {_, _, cred} = setup_credential()
      cs = Credential.perform_changeset(cred, %{oper_pass: "bad\r\npass"})
      refute cs.valid?
      assert %{oper_pass: [_ | _]} = errors_on(cs)
    end

    test "rejects CR/LF/NUL in nickserv_pass (single-line secret)" do
      {_, _, cred} = setup_credential()
      cs = Credential.perform_changeset(cred, %{nickserv_pass: "bad\r\npass"})
      refute cs.valid?
      assert %{nickserv_pass: [_ | _]} = errors_on(cs)
    end

    test "rejects a perform list over the byte cap" do
      {_, _, cred} = setup_credential()
      huge = String.duplicate("MODE $nick +x\n", 2000)
      cs = Credential.perform_changeset(cred, %{perform_list: huge})
      refute cs.valid?
      assert %{perform_list: [_ | _]} = errors_on(cs)
    end
  end
end
