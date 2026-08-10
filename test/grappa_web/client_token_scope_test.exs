defmodule GrappaWeb.ClientTokenScopeTest do
  @moduledoc """
  GH #1196 — the scope boundary IS the feature.

  A per-client token exists so that arming a second factor stops locking
  a headless client out. That is a hardening only while the token is
  strictly less than the account: if it can administer, re-credential,
  or re-mint, then the token is the account and the second factor on the
  account is decorative.

  Every arm below is one edge of that boundary, and each is paired with
  a control — the same route reached by an ordinary browser session —
  so a refusal cannot be mistaken for a route that simply does not work.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Accounts

  setup do
    admin = user_fixture(is_admin: true)
    {:ok, token} = Accounts.create_client_token(admin, "headless client", nil, nil, [])
    web = session_fixture(admin)

    %{admin: admin, token: token, web: web}
  end

  defp as_token(conn, %{token: token}), do: put_bearer(conn, token.id)
  defp as_web(conn, %{web: web}), do: put_bearer(conn, web.id)

  defp assert_scope_refusal(conn) do
    assert json_response(conn, 403) == %{"error" => "client_token_scope"}
  end

  describe "a client token cannot reach the operator console" do
    test "GET /admin/me", %{conn: conn} = ctx do
      conn |> as_token(ctx) |> get("/admin/me") |> assert_scope_refusal()
    end

    test "and the same admin's browser session can", %{conn: conn} = ctx do
      assert %{"name" => _} = conn |> as_web(ctx) |> get("/admin/me") |> json_response(200)
    end
  end

  describe "a client token cannot change the account password" do
    # The account password lives on the admin surface, so this is both
    # the password boundary of #1196 and a second witness that the admin
    # gate covers mutating routes and not merely the console's reads.
    test "PUT /admin/users/:id/password", %{conn: conn, admin: admin} = ctx do
      conn
      |> as_token(ctx)
      |> put("/admin/users/#{admin.id}/password", %{"password" => "a-brand-new-password"})
      |> assert_scope_refusal()
    end

    test "and the same admin's browser session can", %{conn: conn, admin: admin} = ctx do
      conn = conn |> as_web(ctx) |> put("/admin/users/#{admin.id}/password", %{"password" => "a-brand-new-password"})

      refute conn.status == 403
    end
  end

  describe "a client token cannot touch the account's second factors" do
    test "GET /me/totp", %{conn: conn} = ctx do
      conn |> as_token(ctx) |> get("/me/totp") |> assert_scope_refusal()
    end

    test "DELETE /me/totp", %{conn: conn} = ctx do
      conn
      |> as_token(ctx)
      |> delete("/me/totp", %{"password" => "irrelevant"})
      |> assert_scope_refusal()
    end

    test "GET /me/passkeys", %{conn: conn} = ctx do
      conn |> as_token(ctx) |> get("/me/passkeys") |> assert_scope_refusal()
    end

    test "POST /me/passkeys/registration/options", %{conn: conn} = ctx do
      conn
      |> as_token(ctx)
      |> post("/me/passkeys/registration/options", %{})
      |> assert_scope_refusal()
    end

    test "and the browser session reaches them", %{conn: conn} = ctx do
      assert %{"enabled" => false} = conn |> as_web(ctx) |> get("/me/totp") |> json_response(200)
      assert %{"passkeys" => _} = conn |> as_web(ctx) |> get("/me/passkeys") |> json_response(200)
    end
  end

  describe "a client token cannot mint, list, or revoke tokens" do
    test "POST /me/client-tokens", %{conn: conn} = ctx do
      conn
      |> as_token(ctx)
      |> post("/me/client-tokens", %{"label" => "a second one", "password" => "x"})
      |> assert_scope_refusal()
    end

    test "GET /me/client-tokens", %{conn: conn} = ctx do
      conn |> as_token(ctx) |> get("/me/client-tokens") |> assert_scope_refusal()
    end

    test "DELETE /me/client-tokens/:handle", %{conn: conn, token: token} = ctx do
      handle = Grappa.Accounts.Session.handle(token)

      conn |> as_token(ctx) |> delete("/me/client-tokens/#{handle}") |> assert_scope_refusal()
    end

    test "and the browser session reaches the list", %{conn: conn} = ctx do
      assert %{"tokens" => [_]} =
               conn |> as_web(ctx) |> get("/me/client-tokens") |> json_response(200)
    end
  end

  describe "a client token cannot delete the account" do
    test "DELETE /me", %{conn: conn} = ctx do
      conn |> as_token(ctx) |> delete("/me") |> assert_scope_refusal()
    end
  end

  describe "what a client token is FOR still works" do
    # Without this the arms above would be satisfied by a token that can
    # do nothing at all, which is not a feature.
    test "GET /me", %{conn: conn, admin: admin} = ctx do
      assert %{"name" => name} = conn |> as_token(ctx) |> get("/me") |> json_response(200)
      assert name == admin.name
    end

    test "GET /networks", %{conn: conn} = ctx do
      # The account holds no credential, so the honest answer is the
      # empty list — what matters is that it is a 200 from the resource
      # surface and not the scope refusal the arms above assert.
      assert conn |> as_token(ctx) |> get("/networks") |> json_response(200) == []
    end
  end
end
