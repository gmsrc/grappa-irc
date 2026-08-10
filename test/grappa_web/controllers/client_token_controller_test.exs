defmodule GrappaWeb.ClientTokenControllerTest do
  @moduledoc """
  GH #1196 — the three verbs an account uses to issue, see, and kill a
  per-client token.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Accounts
  alias Grappa.Accounts.Session

  setup %{conn: conn} do
    {user, password} = user_fixture_with_password()
    session = session_fixture(user)

    %{conn: put_bearer(conn, session.id), user: user, password: password}
  end

  describe "POST /me/client-tokens" do
    test "mints a usable token and shows it once", %{conn: conn, user: user, password: password} do
      body =
        conn
        |> post("/me/client-tokens", %{"label" => "weechat", "password" => password})
        |> json_response(201)

      assert body["label"] == "weechat"
      assert %{"token" => token, "handle" => handle} = body

      # The secret works as a bearer straight away, and the handle it
      # was announced under is the one the list will publish.
      assert {:ok, %Session{kind: :client}} = Accounts.authenticate(token)
      assert handle == Session.handle(token)
      assert [%Session{}] = Accounts.list_client_tokens(user)
    end

    test "the list never gives the secret back", %{conn: conn, password: password} do
      minted =
        conn
        |> post("/me/client-tokens", %{"label" => "irssi", "password" => password})
        |> json_response(201)

      %{"tokens" => [listed]} = conn |> get("/me/client-tokens") |> json_response(200)

      assert listed["handle"] == minted["handle"]
      refute Map.has_key?(listed, "token")
      refute listed |> Map.values() |> Enum.member?(minted["token"])
    end

    test "refuses without the account password", %{conn: conn} do
      body =
        conn
        |> post("/me/client-tokens", %{"label" => "borrowed", "password" => "not-the-password"})
        |> json_response(401)

      assert body == %{"error" => "invalid_credentials"}
    end

    test "refuses when the password is absent entirely", %{conn: conn} do
      assert conn
             |> post("/me/client-tokens", %{"label" => "no password"})
             |> json_response(400) == %{"error" => "bad_request"}
    end

    test "surfaces the per-account cap as a distinct 422", %{
      conn: conn,
      user: user,
      password: password
    } do
      for n <- 1..20, do: Accounts.create_client_token(user, "client #{n}", nil, nil, [])

      assert conn
             |> post("/me/client-tokens", %{"label" => "one too many", "password" => password})
             |> json_response(422) == %{"error" => "client_token_cap_reached"}
    end
  end

  describe "DELETE /me/client-tokens/:handle" do
    test "revokes by handle without ever re-presenting the secret", %{
      conn: conn,
      user: user,
      password: password
    } do
      %{"token" => token, "handle" => handle} =
        conn
        |> post("/me/client-tokens", %{"label" => "compromised", "password" => password})
        |> json_response(201)

      assert conn |> delete("/me/client-tokens/#{handle}") |> response(204)

      assert {:error, :revoked} = Accounts.authenticate(token)
      assert Accounts.list_client_tokens(user) == []
    end

    test "an unknown handle is a 404", %{conn: conn} do
      assert conn
             |> delete("/me/client-tokens/deadbeefcafe")
             |> json_response(404) == %{"error" => "not_found"}
    end

    test "another account's handle is a 404, and their token survives", %{conn: conn} do
      stranger = user_fixture()
      {:ok, theirs} = Accounts.create_client_token(stranger, "theirs", nil, nil, [])

      assert conn
             |> delete("/me/client-tokens/#{Session.handle(theirs)}")
             |> json_response(404) == %{"error" => "not_found"}

      assert {:ok, %Session{}} = Accounts.authenticate(theirs.id)
    end
  end

  describe "visitors" do
    test "have no account to issue a token for", %{conn: conn} do
      {_, session} = visitor_and_session()

      conn = conn |> recycle() |> put_bearer(session.id)

      assert conn |> get("/me/client-tokens") |> json_response(403) == %{"error" => "forbidden"}
    end
  end
end
