defmodule GrappaWeb.AuthControllerClientTokenTest do
  @moduledoc """
  GH #1196 — `POST /auth/login` accepting a per-client token in the
  `password` field.

  The lockout this removes is concrete: with TOTP armed, an account's
  password login answers 202 `two_factor_required` and a headless client
  has nowhere to put a code that rotates every thirty seconds. The first
  describe is that lockout and its way out, measured on one account.

  `async: false` — the login throttle is a global ETS singleton keyed by
  source IP, exactly as in `GrappaWeb.AuthControllerTest`.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Accounts
  alias Grappa.Accounts.TOTP
  alias Grappa.RateLimit.FailureWindow

  @rfc_secret "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

  setup do
    :ets.delete_all_objects(FailureWindow.table_name())
    :ok
  end

  defp with_ip(conn, d), do: %{conn | remote_ip: {10, 77, 0, d}}

  defp login(conn, name, password) do
    post(conn, "/auth/login", %{"identifier" => name, "password" => password})
  end

  defp arm_totp(user) do
    now = System.system_time(:second)
    {:ok, code} = TOTP.code_at(@rfc_secret, now)
    {:ok, _codes} = TOTP.confirm_enrollment(user, @rfc_secret, code, now)
    :ok
  end

  describe "an account with TOTP armed" do
    setup do
      {user, password} = user_fixture_with_password()
      :ok = arm_totp(user)
      {:ok, token} = Accounts.create_client_token(user, "weechat on the vps", nil, nil, [])

      %{user: user, password: password, token: token}
    end

    test "still asks a password login for the second factor", %{
      conn: conn,
      user: user,
      password: password
    } do
      body = conn |> with_ip(1) |> login(user.name, password) |> json_response(202)

      assert body["two_factor_required"] == true
    end

    test "admits the client token straight through, and answers with that same token", %{
      conn: conn,
      user: user,
      token: token
    } do
      body = conn |> with_ip(1) |> login(user.name, token.id) |> json_response(200)

      # The row IS the bearer, so a reconnect does not accrete a second
      # session row — the client gets back what it already had.
      assert body["token"] == token.id
      refute body["two_factor_required"]
      assert body["subject"]["name"] == user.name
    end
  end

  describe "what the password field will not accept" do
    setup do
      {user, password} = user_fixture_with_password()
      {:ok, token} = Accounts.create_client_token(user, "laptop", nil, nil, [])

      %{user: user, password: password, token: token}
    end

    test "a browser bearer for the same account", %{conn: conn, user: user} do
      web = session_fixture(user)

      body = conn |> with_ip(2) |> login(user.name, web.id) |> json_response(401)

      assert body == %{"error" => "invalid_credentials"}
    end

    test "another account's client token", %{conn: conn, token: token} do
      {stranger, _} = user_fixture_with_password()

      body = conn |> with_ip(3) |> login(stranger.name, token.id) |> json_response(401)

      assert body == %{"error" => "invalid_credentials"}
    end

    test "a revoked token", %{conn: conn, user: user, token: token} do
      :ok = Accounts.revoke_client_token(user, Grappa.Accounts.Session.handle(token))

      body = conn |> with_ip(4) |> login(user.name, token.id) |> json_response(401)

      assert body == %{"error" => "invalid_credentials"}
    end
  end

  describe "the token door buys no extra guesses" do
    # A UUID-shaped wrong password takes the token lookup AND the Argon2
    # ladder. If the extra door charged its own failure, the account's
    # ten-per-window budget would be spent in five attempts — so the
    # count is what proves the two doors share one charge.
    test "a wrong UUID-shaped password charges the window exactly once per attempt", %{
      conn: conn
    } do
      {user, password} = user_fixture_with_password()
      wrong = Ecto.UUID.generate()

      for _ <- 1..5 do
        assert conn |> with_ip(5) |> login(user.name, wrong) |> json_response(401)
      end

      # Half the budget spent, not all of it.
      assert conn |> with_ip(5) |> login(user.name, password) |> json_response(200)

      for _ <- 1..5 do
        assert conn |> with_ip(5) |> login(user.name, wrong) |> json_response(401)
      end

      assert conn |> with_ip(5) |> login(user.name, password) |> json_response(429) ==
               %{"error" => "too_many_attempts"}
    end
  end
end
