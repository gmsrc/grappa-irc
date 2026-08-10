defmodule GrappaWeb.RouterScopeTest do
  @moduledoc """
  GH #1196 — a router-table invariant, not a route test.

  The scope gate is mounted per pipeline, so a credential-management
  route declared inside the right block inherits it automatically. The
  hazard is the route declared in the WRONG block: it authenticates, it
  works, and it is silently reachable by a per-client token. Nothing
  about it looks wrong at the call site.

  So this enumerates the compiled route table and actually DRIVES every
  credential-management route with a client-token bearer, asserting the
  scope refusal each time. Exercising beats introspecting the pipelines:
  it survives a plug being moved between pipelines, and it fails on the
  thing that matters — the response — rather than on a spelling.

  The bearer belongs to an ADMIN account on purpose. A non-admin would
  be refused by `GrappaWeb.Admin.AuthPlug` first, and every `/admin` arm
  would pass for the wrong reason; requiring the body to be exactly
  `client_token_scope` is what keeps the admin arms honest.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Accounts

  # Paths that can change what the account IS, as opposed to using it.
  # Prefix-matched, so `/me/totp/enrollment/confirm` is covered by
  # `/me/totp` and a new sibling needs no edit here.
  @credential_prefixes ["/admin", "/me/totp", "/me/passkeys", "/me/client-tokens"]

  # Exact `{method, path}` pairs that are credential management without
  # looking like it from the prefix alone.
  @credential_routes [{"DELETE", "/me"}]

  # The loopback `/admin` scope (`POST /admin/reload`,
  # `/admin/cic-bundle-changed`) carries no bearer at all: it is gated on
  # the transport peer by `GrappaWeb.Plugs.LoopbackOnly`, so there is no
  # session whose kind could be checked, and driving it here would run a
  # real code reload. Identified by its controller — the loopback scope
  # routes to `GrappaWeb.AdminController`, the operator console to
  # `GrappaWeb.Admin.*` — so a console route can never fall into the
  # exclusion by being named `/admin/something`.
  @loopback_plug GrappaWeb.AdminController

  defp method(%{verb: verb}), do: verb |> Atom.to_string() |> String.upcase()

  defp credential_management?(%{path: path} = route) do
    Enum.any?(@credential_prefixes, &String.starts_with?(path, &1)) or
      {method(route), path} in @credential_routes
  end

  defp credential_routes do
    GrappaWeb.Router.__routes__()
    |> Enum.filter(&credential_management?/1)
    |> Enum.reject(&(&1.plug == @loopback_plug))
  end

  # `:id` / `:handle` / `:network_id` only have to be routable; the scope
  # gate runs in the pipeline, upstream of any controller that would
  # care what they contain.
  defp concrete_path(%{path: path}) do
    path
    |> String.split("/")
    |> Enum.map_join("/", fn
      ":" <> _ -> "placeholder"
      "*" <> _ -> "placeholder"
      segment -> segment
    end)
  end

  defp drive(conn, route) do
    path = concrete_path(route)

    case route.verb do
      :get -> get(conn, path)
      :post -> post(conn, path, %{})
      :put -> put(conn, path, %{})
      :patch -> patch(conn, path, %{})
      :delete -> delete(conn, path)
    end
  end

  test "no credential-management route answers a per-client token" do
    admin = user_fixture(is_admin: true)
    {:ok, token} = Accounts.create_client_token(admin, "headless", nil, nil, [])

    for route <- credential_routes() do
      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(token.id)
        |> drive(route)

      assert json_response(conn, 403) == %{"error" => "client_token_scope"},
             """
             #{method(route)} #{route.path} is reachable by a per-client token.

             Mount it on the `:full_session` scope (or `:admin_authn`) in
             GrappaWeb.Router — see GH #1196.
             """
    end
  end

  test "the invariant has something to check" do
    # A filter that matches nothing passes vacuously forever. This is the
    # arm that notices when a router refactor renames the paths out from
    # under the prefixes above.
    matched = credential_routes()

    assert length(matched) > 20

    for prefix <- @credential_prefixes do
      assert Enum.any?(matched, &String.starts_with?(&1.path, prefix)),
             "no route matches the credential prefix #{prefix} any more"
    end

    for {verb, path} <- @credential_routes do
      assert Enum.any?(matched, &(&1.path == path and method(&1) == verb)),
             "no route matches #{verb} #{path} any more"
    end
  end
end
