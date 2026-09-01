defmodule Grappa.Networks.ServerPassSlotTest do
  @moduledoc """
  GH #1044 — the SECOND secret slot: `server_pass_encrypted`, user-only.

  A credential used to have exactly one secret slot, and `auth_method` decided
  which single role it was spent on. On a password-gated network the server
  `PASS` and the NickServ secret are not alternatives, so one of the two had
  nowhere to live. #124's retired column is resurrected under the name of the
  role it now carries, and `password_encrypted` KEEPS the NickServ meaning —
  the direction matters, because on every visitor row `password_encrypted` IS
  the NickServ secret (`Grappa.Visitors.SessionPlan`).

  Two things are pinned here, and the second is the load-bearing one:

    * the user branch stores the slot, encrypted at rest, through the wide
      changeset — and refuses a value that would split the PASS wire line;
    * the VISITOR branch is untouched. A visitor's `auth_method` is DERIVED
      from the presence of one secret and never reaches `:server_pass`, so the
      slot is REFUSED there rather than dropped — and their NickServ session
      keeps resolving exactly as before, asserted through the plan the session
      is actually built from rather than through the column.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.{Credential, Credentials, SessionPlan}
  alias Grappa.Repo
  alias Grappa.Visitors.SessionPlan, as: VisitorSessionPlan

  defp uniq, do: System.unique_integer([:positive])

  defp network do
    {net, _} = network_with_server(port: 6667, slug: "azzurra-#{uniq()}")
    net
  end

  # Read the column the way storage sees it: the Ecto type decrypts on load, so
  # a schema read cannot tell a stored ciphertext from a stored plaintext.
  defp raw_slot(%Credential{id: id}) do
    %{rows: [[blob]]} =
      Repo.query!("SELECT server_pass_encrypted FROM network_credentials WHERE id = ?", [id])

    blob
  end

  defp reload(%Credential{id: id}), do: Repo.get!(Credential, id)

  defp reload_by_ids(user_id, network_id) do
    {:ok, cred} = Credentials.get_credential_by_ids(user_id, network_id)
    cred
  end

  describe "the user branch owns the slot" do
    test "a server_pass on the wide changeset lands in the column, encrypted at rest" do
      user = user_fixture(name: "vjt-#{uniq()}")
      net = network()

      {:ok, cred} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :server_pass,
          password: "wire-side",
          server_pass: "hunter2"
        })

      assert reload(cred).server_pass_encrypted == "hunter2"
      refute raw_slot(cred) == "hunter2"
      refute is_nil(raw_slot(cred))
    end

    test "the slot is independent of password_encrypted — both secrets coexist" do
      user = user_fixture(name: "vjt-#{uniq()}")
      net = network()

      {:ok, cred} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :nickserv_identify,
          password: "ns-secret",
          server_pass: "hunter2"
        })

      stored = reload(cred)

      # The whole point of #1044: the NickServ role and the server-PASS role
      # each have their own home, and neither reads the other.
      assert Credential.recover_secret(stored) == "ns-secret"
      assert stored.server_pass_encrypted == "hunter2"
    end

    test "omitting server_pass on a later update keeps the stored one" do
      user = user_fixture(name: "vjt-#{uniq()}")
      net = network()

      {:ok, _} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :server_pass,
          password: "wire-side",
          server_pass: "hunter2"
        })

      {:ok, updated} = Credentials.update_credential(user, net, %{nick: "vjt2"})

      assert reload(updated).server_pass_encrypted == "hunter2"
    end

    test "a CRLF server_pass is refused — the value is re-interpolated into PASS" do
      user = user_fixture(name: "vjt-#{uniq()}")
      net = network()

      {:error, changeset} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :server_pass,
          password: "wire-side",
          server_pass: "hunter2\r\nJOIN #evil"
        })

      assert %{server_pass: [_ | _]} = errors_on(changeset)
    end
  end

  describe "the read side — accessor and plan" do
    test "upstream_server_pass/1 returns the post-Cloak-load plaintext" do
      user = user_fixture(name: "vjt-#{uniq()}")
      net = network()

      {:ok, cred} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :server_pass,
          server_pass: "hunter2"
        })

      assert Credential.upstream_server_pass(reload(cred)) == "hunter2"
    end

    test "upstream_server_pass/1 is nil when the slot was never written" do
      user = user_fixture(name: "vjt-#{uniq()}")
      net = network()

      {:ok, cred} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :nickserv_identify,
          password: "ns-secret"
        })

      assert is_nil(Credential.upstream_server_pass(reload(cred)))
    end

    # The middle link, and the one nothing else watches: the accessor test
    # proves the column round-trips and the AuthFSM test proves the PASS line
    # reads the slot, but only this proves the value TRAVELS from the row the
    # operator configured to the plan the session is built from. A plan that
    # dropped it would leave both neighbours green while every gated network
    # failed its handshake.
    test "the plan carries BOTH secrets, each in its own key" do
      user = user_fixture(name: "vjt-#{uniq()}")
      net = network()

      {:ok, _} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :server_pass,
          password: "ns-secret",
          server_pass: "gate-secret"
        })

      {:ok, plan} = SessionPlan.resolve(reload_by_ids(user.id, net.id))

      assert plan.server_pass == "gate-secret"
      assert plan.password == "ns-secret"
    end
  end

  describe "the visitor branch is untouched (#1044's explicit constraint)" do
    setup do
      net = network()
      visitor = visitor_fixture(nick: "guest#{uniq()}", network_slug: net.slug)
      {:ok, _} = Credentials.commit_visitor_password(visitor.id, net.id, "ns-secret")
      %{net: net, visitor: visitor}
    end

    test "a server_pass on a visitor upsert is REFUSED, not silently dropped", %{
      net: net,
      visitor: visitor
    } do
      # A discarded secret is a silent lie to whoever set it: the operator
      # believes a server PASS is stored and it is nowhere. No door sends this
      # today, so the guard costs nothing — and it meets whoever opens one
      # later with an error instead of a mute hole.
      {:error, changeset} =
        Credentials.upsert_visitor_credential(visitor.id, net.id, %{
          nick: "guest#{uniq()}",
          server_pass: "hunter2"
        })

      assert %{server_pass: ["is only valid on a user credential"]} = errors_on(changeset)
    end

    test "the refused write stores nothing at all", %{net: net, visitor: visitor} do
      {:error, _} =
        Credentials.upsert_visitor_credential(visitor.id, net.id, %{
          nick: "guest#{uniq()}",
          server_pass: "hunter2"
        })

      {:ok, cred} = Credentials.get_visitor_credential(visitor.id, net.id)

      assert is_nil(raw_slot(cred))
    end

    test "the visitor's NickServ secret is untouched by the refusal", %{
      net: net,
      visitor: visitor
    } do
      {:error, _} =
        Credentials.upsert_visitor_credential(visitor.id, net.id, %{
          nick: "guest#{uniq()}",
          server_pass: "hunter2"
        })

      {:ok, stored} = Credentials.get_visitor_credential(visitor.id, net.id)

      assert stored.auth_method == :nickserv_identify
      assert Credential.recover_secret(stored) == "ns-secret"
    end

    test "the session plan still identifies with the NickServ secret", %{
      net: net,
      visitor: visitor
    } do
      {:error, _} =
        Credentials.upsert_visitor_credential(visitor.id, net.id, %{
          nick: "guest#{uniq()}",
          server_pass: "hunter2"
        })

      {:ok, plan} = VisitorSessionPlan.resolve(visitor, net)

      # The plan is what the session is actually built from: a visitor's
      # auth_method is DERIVED from the one secret, and #1044 must not shift it.
      assert plan.auth_method == :nickserv_identify
      assert plan.password == "ns-secret"
    end
  end
end
