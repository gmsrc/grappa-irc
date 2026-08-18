defmodule GrappaWeb.Admin.VhostsControllerTest do
  @moduledoc """
  #228 — `/admin/vhosts` inventory + grants CRUD. Behind `:admin_authn`;
  visitor + non-admin user collapse to 403 upstream.

  ## Test isolation

  `async: true` — every test scopes to freshly-created rows through the
  Repo sandbox; cleanup is automatic.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Net.HostAddresses
  alias Grappa.{Networks.Credentials, ServerSettings, Vhosts}

  defp addr do
    n = Bitwise.band(System.unique_integer([:positive]), 0xFFFF)
    "2001:db8::" <> String.downcase(Integer.to_string(n, 16))
  end

  describe "auth gate" do
    test "no bearer returns 401", %{conn: conn} do
      conn = get(conn, "/admin/vhosts")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/vhosts")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/vhosts")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/vhosts" do
    test "lists vhosts, grants, and host candidates", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr(), in_pool: true})

      conn = conn |> put_bearer(session.id) |> get("/admin/vhosts")
      body = json_response(conn, 200)

      assert Enum.any?(body["vhosts"], &(&1["id"] == v.id and &1["in_pool"] == true))
      assert is_list(body["grants"])
      assert is_list(body["host_candidates"])
    end

    # #1157 — THE mode-1 pin the ruling asked for by name.
    #
    # `pool_with_reservations` is the default and is what every server
    # that never configured a derivation block runs. Its candidate list
    # must survive the new filter byte-identical. Asserting `is_list/1`
    # (the contract before this change) would pass just as happily on a
    # filter that emptied the picker, so assert the WHOLE list against
    # the unfiltered universe.
    test "mode 1 (no prefix configured) returns the candidate list IDENTICAL", %{conn: conn} do
      session = admin_session()
      assert ServerSettings.static_mapping_prefix() == nil

      conn = conn |> put_bearer(session.id) |> get("/admin/vhosts")

      assert json_response(conn, 200)["host_candidates"] == HostAddresses.list()
    end

    # #1157 — the positive direction: a configured derivation block is
    # withheld from the picker.
    #
    # Honest limit: the universe here is the real kernel interface table,
    # so this can only exclude an address the host actually has. On a
    # host with a v6 interface we pin the strong claim (that address is
    # GONE, the v4 ones stay); on a v4-only host there is no derived
    # alias to hide and we pin the wiring instead. The filtering maths
    # itself is pinned deterministically, with synthetic input, in
    # `Grappa.Net.HostAddressesTest`.
    test "a configured static-mapping prefix is withheld from the candidates", %{conn: conn} do
      session = admin_session()
      candidates = HostAddresses.list()

      case Enum.find(candidates, &String.contains?(&1, ":")) do
        nil ->
          prefix = "2001:db8:1157::/64"
          :ok = ServerSettings.put_static_mapping_prefix(prefix)
          conn = conn |> put_bearer(session.id) |> get("/admin/vhosts")

          assert json_response(conn, 200)["host_candidates"] ==
                   HostAddresses.reject_in_prefix(candidates, prefix)

        v6 ->
          :ok = ServerSettings.put_static_mapping_prefix(v6 <> "/128")
          conn = conn |> put_bearer(session.id) |> get("/admin/vhosts")
          returned = json_response(conn, 200)["host_candidates"]

          refute v6 in returned

          for v4 <- Enum.reject(candidates, &String.contains?(&1, ":")) do
            assert v4 in returned
          end
      end
    end

    # #1140 — the listing used to assert only `is_list(body["grants"])`,
    # which a wire that prints nothing but UUIDs satisfies. Assert the
    # rendered identity.
    test "a user grant carries the account name, not just the uuid", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      target = user_fixture(name: "granted1140")
      {:ok, grant} = Vhosts.grant_vhost(v, {:user, target.id})

      conn = conn |> put_bearer(session.id) |> get("/admin/vhosts")
      row = Enum.find(json_response(conn, 200)["grants"], &(&1["id"] == grant.id))

      assert row["subject_id"] == target.id
      assert row["subject_label"] == "granted1140"
    end

    test "a visitor grant carries the representative credential nick", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {visitor, network} = visitor_with_network(7140)

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: "vgranted1140",
          auth_method: :none
        })

      {:ok, grant} = Vhosts.grant_vhost(v, {:visitor, visitor.id})

      conn = conn |> put_bearer(session.id) |> get("/admin/vhosts")
      row = Enum.find(json_response(conn, 200)["grants"], &(&1["id"] == grant.id))

      assert row["subject_type"] == "visitor"
      assert row["subject_id"] == visitor.id
      assert row["subject_label"] == "vgranted1140"
    end

    # #1140 — a visitor holding no credential has no nick to show. `nil` is
    # the honesty signal (same rule as `/admin/sessions`' subject_label);
    # cic falls back to the uuid rather than printing a fabricated name.
    test "a subject with no resolvable name renders subject_label: null", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      visitor = visitor_fixture(network_slug: "absent-network-1140")
      {:ok, grant} = Vhosts.grant_vhost(v, {:visitor, visitor.id})

      conn = conn |> put_bearer(session.id) |> get("/admin/vhosts")
      row = Enum.find(json_response(conn, 200)["grants"], &(&1["id"] == grant.id))

      assert row["subject_id"] == visitor.id
      # `has_key?` FIRST: a wire that never carries the field also reads
      # `nil` here, so the bare nil assertion passed against the pre-#1140
      # shape. The claim is "present and null", not "absent".
      assert Map.has_key?(row, "subject_label")
      assert row["subject_label"] == nil
    end
  end

  describe "POST /admin/vhosts" do
    test "creates a vhost", %{conn: conn} do
      session = admin_session()
      a = addr()
      conn = conn |> put_bearer(session.id) |> post("/admin/vhosts", %{address: a, in_pool: true})
      body = json_response(conn, 201)
      assert body["address"] == a
      assert body["in_pool"] == true
    end

    test "rejects an invalid address with 422", %{conn: conn} do
      session = admin_session()
      conn = conn |> put_bearer(session.id) |> post("/admin/vhosts", %{address: "nope"})
      assert json_response(conn, 422)["error"] == "validation_failed"
    end

    test "rejects a duplicate with 409", %{conn: conn} do
      session = admin_session()
      a = addr()
      {:ok, _} = Vhosts.create_vhost(%{address: a})
      conn = conn |> put_bearer(session.id) |> post("/admin/vhosts", %{address: a})
      assert json_response(conn, 409)["error"] == "already_exists"
    end

    test "rejects an unknown body key with 400", %{conn: conn} do
      session = admin_session()
      conn = conn |> put_bearer(session.id) |> post("/admin/vhosts", %{address: addr(), in_pooll: true})
      assert json_response(conn, 400)["error"] == "bad_request"
    end
  end

  describe "PATCH /admin/vhosts/:id" do
    test "updates availability flags", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      conn = conn |> put_bearer(session.id) |> patch("/admin/vhosts/#{v.id}", %{generally_available: true})
      assert json_response(conn, 200)["generally_available"] == true
    end

    test "404s an unknown id", %{conn: conn} do
      session = admin_session()
      conn = conn |> put_bearer(session.id) |> patch("/admin/vhosts/999999", %{in_pool: true})
      assert json_response(conn, 404)["error"] == "not_found"
    end
  end

  describe "DELETE /admin/vhosts/:id" do
    test "deletes a vhost", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      conn = conn |> put_bearer(session.id) |> delete("/admin/vhosts/#{v.id}")
      assert response(conn, 204)
      assert {:error, :not_found} = Vhosts.get_vhost(v.id)
    end
  end

  describe "POST /admin/vhosts/:id/grants" do
    test "grants a vhost to a user", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      target = user_fixture()

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/vhosts/#{v.id}/grants", %{subject_type: "user", subject_id: target.id})

      body = json_response(conn, 201)
      assert body["vhost_id"] == v.id
      assert body["subject_type"] == "user"
      assert body["subject_id"] == target.id
      # #251 — a grant is availability-only; no pinned field on the wire.
      refute Map.has_key?(body, "pinned")

      # #1140 — every door renders the same grant shape: the 201 body
      # carries the identity too, not only the index listing.
      assert body["subject_label"] == target.name
    end

    test "404s an unknown subject", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/vhosts/#{v.id}/grants", %{
          subject_type: "user",
          subject_id: "00000000-0000-0000-0000-000000000000"
        })

      assert json_response(conn, 404)["error"] == "not_found"
    end
  end

  describe "DELETE /admin/vhosts/grants/:grant_id" do
    test "revokes a grant", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      target = user_fixture()
      {:ok, grant} = Vhosts.grant_vhost(v, {:user, target.id})

      conn = conn |> put_bearer(session.id) |> delete("/admin/vhosts/grants/#{grant.id}")
      assert response(conn, 204)
      assert Vhosts.list_grants_for_subject({:user, target.id}) == []
    end
  end

  # #257 — subject autocomplete backing endpoint. Read-only, rides the
  # existing `vhosts` nginx allowlist alt (no proxy change). The returned
  # `{type, id}` maps 1:1 onto the grant body `{subject_type, subject_id}`.
  describe "GET /admin/vhosts/subject_search" do
    test "non-admin user returns 403 (admin_authn gate)", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/vhosts/subject_search", %{q: "anything"})

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "a missing q returns 400", %{conn: conn} do
      session = admin_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/vhosts/subject_search")
      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "returns a tagged :user result", %{conn: conn} do
      session = admin_session()
      target = user_fixture(name: "subjsearch257")

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/vhosts/subject_search", %{q: "subjsearch257"})

      results = json_response(conn, 200)["results"]

      assert Enum.any?(results, fn r ->
               r == %{
                 "type" => "user",
                 "id" => target.id,
                 "network" => nil,
                 "nick" => "subjsearch257"
               }
             end)
    end

    test "returns a tagged :visitor result carrying the network slug", %{conn: conn} do
      session = admin_session()
      {visitor, network} = visitor_with_network(7301)

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: "visearch257",
          auth_method: :none
        })

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/vhosts/subject_search", %{q: "visearch257"})

      results = json_response(conn, 200)["results"]

      assert Enum.any?(results, fn r ->
               r == %{
                 "type" => "visitor",
                 "id" => visitor.id,
                 "network" => network.slug,
                 "nick" => "visearch257"
               }
             end)
    end

    test "a searched subject feeds the grant body 1:1", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      target = user_fixture(name: "grantflow257")

      search_conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/vhosts/subject_search", %{q: "grantflow257"})

      [result | _] = json_response(search_conn, 200)["results"]

      grant_conn =
        build_conn()
        |> put_bearer(session.id)
        |> post("/admin/vhosts/#{v.id}/grants", %{
          subject_type: result["type"],
          subject_id: result["id"]
        })

      body = json_response(grant_conn, 201)
      assert body["subject_type"] == "user"
      assert body["subject_id"] == target.id
    end
  end
end
