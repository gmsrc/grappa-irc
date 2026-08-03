defmodule GrappaWeb.PasskeyControllerTest do
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures
  import Ecto.Query

  alias Grappa.Accounts.{Passkey, Session, TOTP, TOTPRecoveryCode, User, WebAuthn}
  alias Grappa.RateLimit.FailureWindow
  alias Grappa.Repo

  defp passwordless_user do
    {user, password} = user_fixture_with_password()
    session = session_fixture(user)

    Repo.insert!(
      Passkey.changeset(%Passkey{}, %{
        user_id: user.id,
        credential_id: :crypto.strong_rand_bytes(16),
        public_key: CBOR.encode(%{1 => 2, 3 => -7}),
        name: "phone"
      })
    )

    {:ok, "passwordless"} =
      WebAuthn.set_mode(user, "passwordless", session.id, Grappa.Accounts.prepare_recovery_codes())

    {Repo.get!(User, user.id), password}
  end

  test "login_options is throttled even while it keeps succeeding", %{conn: conn} do
    # The abuse is challenge ALLOCATION, and the cheapest way to allocate
    # is to keep succeeding — so a failures-only window would never see
    # this traffic. Every 200 has to count against the bucket too.
    {user, _password} = passwordless_user()
    on_exit(fn -> FailureWindow.clear(:passkey_login_options, "127.0.0.1") end)

    for _ <- 1..30 do
      assert conn |> post("/auth/passkeys/options", %{"identifier" => user.name}) |> Map.get(:status) == 200
    end

    assert conn
           |> post("/auth/passkeys/options", %{"identifier" => user.name})
           |> json_response(429) == %{"error" => "too_many_attempts"}
  end

  test "recovery throttling survives respelling the identifier", %{conn: conn} do
    # find_user/1 folds an email to its local part, so these all resolve to
    # ONE account. Keying the window on the wire string handed the attacker
    # a fresh bucket per spelling.
    {user, _password} = passwordless_user()

    on_exit(fn ->
      FailureWindow.clear(:passkey_recovery, "127.0.0.1")
      FailureWindow.clear(:passkey_recovery, {"127.0.0.1", user.id})
    end)

    spellings = Stream.cycle([user.name, "#{user.name}@a.aa", "#{user.name}@b.bb"])

    for identifier <- Enum.take(spellings, 10) do
      post(conn, "/auth/passkeys/recover", %{
        "identifier" => identifier,
        "recovery_code" => "wrongwrongwrongwrongwrongw"
      })
    end

    assert conn
           |> post("/auth/passkeys/recover", %{
             "identifier" => "#{user.name}@c.cc",
             "recovery_code" => "wrongwrongwrongwrongwrongw"
           })
           |> json_response(429) == %{"error" => "too_many_attempts"}
  end

  test "passwordless mode rejects password and accepts a one-shot recovery code", %{conn: conn} do
    {user, password} = user_fixture_with_password()
    secret = TOTP.new_enrollment(user, "Grappa test").secret
    now = System.system_time(:second)
    {:ok, code} = TOTP.code_at(secret, now)
    {:ok, [recovery | _]} = TOTP.confirm_enrollment(user, secret, code, now)

    User
    |> where([u], u.id == ^user.id)
    |> Repo.update_all(set: [passkey_mode: "passwordless"])

    rejected = post(conn, "/auth/login", %{"identifier" => user.name, "password" => password})
    assert json_response(rejected, 401) == %{"error" => "invalid_credentials"}

    body =
      conn
      |> post("/auth/passkeys/recover", %{"identifier" => user.name, "recovery_code" => recovery})
      |> json_response(200)

    assert is_binary(body["token"])

    replay = post(conn, "/auth/passkeys/recover", %{"identifier" => user.name, "recovery_code" => recovery})
    assert json_response(replay, 401) == %{"error" => "invalid_two_factor"}
  end

  test "recovery checkpoint does not activate passwordless or persist codes", %{conn: conn} do
    {user, password} = user_fixture_with_password()
    session = session_fixture(user)

    prepared =
      conn
      |> put_req_header("authorization", "Bearer #{session.id}")
      |> post("/me/passkeys/passwordless/recovery", %{"password" => password})
      |> json_response(200)

    assert length(prepared["recovery_codes"]) == 10
    assert is_binary(prepared["recovery_token"])
    assert Repo.get!(User, user.id).passkey_mode == "disabled"
    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 0
    assert is_nil(Repo.get!(Session, session.id).revoked_at)
  end

  test "last passkey can be deleted after returning to password login", %{conn: conn} do
    {user, password} = user_fixture_with_password()
    session = session_fixture(user)

    passkey =
      Repo.insert!(
        Passkey.changeset(%Passkey{}, %{
          user_id: user.id,
          credential_id: <<1, 2, 3>>,
          public_key: CBOR.encode(%{1 => 2, 3 => -7}),
          name: "phone"
        })
      )

    assert {:ok, "passwordless"} =
             WebAuthn.set_mode(user, "passwordless", session.id, Grappa.Accounts.prepare_recovery_codes())

    blocked =
      conn
      |> put_req_header("authorization", "Bearer #{session.id}")
      |> delete("/me/passkeys/#{passkey.id}", %{"password" => password})

    assert json_response(blocked, 409) == %{"error" => "passkey_required"}

    passwordless_user = Repo.get!(User, user.id)
    assert {:ok, "disabled"} = WebAuthn.set_mode(passwordless_user, "disabled", session.id)

    conn = put_req_header(recycle(conn), "authorization", "Bearer #{session.id}")
    assert response(delete(conn, "/me/passkeys/#{passkey.id}", %{"password" => password}), 204)
    assert Repo.aggregate(Passkey, :count, :id) == 0
  end
end
