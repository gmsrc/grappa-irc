defmodule Grappa.Accounts.PasskeyTest do
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Accounts.Passkey, Accounts.TOTPRecoveryCode, Accounts.WebAuthn, Repo}

  test "registration options are RP-bound and password-gated" do
    {user, password} = user_fixture_with_password()
    binding = %{ip: "192.0.2.1", client_id: "client"}

    assert {:error, :invalid_credentials} =
             WebAuthn.begin_registration(user, "wrong-password", "phone", binding, "https://irc.example")

    assert {:ok, %{challenge_id: id, public_key: options}} =
             WebAuthn.begin_registration(user, password, "phone", binding, "https://irc.example")

    assert is_binary(id)
    assert options.rp.id == "irc.example"
    assert options.user.name == user.name
    assert options.authenticatorSelection.userVerification == "required"
  end

  describe "begin_authentication/5 credential exposure" do
    setup do
      user = user_fixture()
      other = user_fixture()
      key = %{1 => 2, 3 => -7, -1 => 1, -2 => <<0::256>>, -3 => <<0::256>>}

      Repo.insert!(
        Passkey.changeset(%Passkey{}, %{
          user_id: user.id,
          credential_id: <<1, 2, 3>>,
          public_key: CBOR.encode(key),
          name: "phone",
          transports: %{"values" => ["usb"]}
        })
      )

      Repo.insert!(
        Passkey.changeset(%Passkey{}, %{
          user_id: other.id,
          credential_id: <<4, 5, 6>>,
          public_key: CBOR.encode(key),
          name: "other"
        })
      )

      %{user: user, binding: %{ip: "192.0.2.1", client_id: nil}}
    end

    test "passwordless stays discoverable and hands no credential id to an anonymous caller", ctx do
      assert {:ok, %{public_key: options}} =
               WebAuthn.begin_authentication(ctx.user, :passwordless, ctx.binding, "https://irc.example")

      assert options.rpId == "irc.example"
      refute Map.has_key?(options, :allowCredentials)
    end

    for purpose <- [:second_factor, :mode_change] do
      test "#{purpose} lists the account's own credentials so a non-discoverable key can answer", ctx do
        assert {:ok, %{public_key: options}} =
                 WebAuthn.begin_authentication(ctx.user, unquote(purpose), ctx.binding, "https://irc.example")

        assert [%{type: "public-key", id: id, transports: ["usb"]}] = options.allowCredentials
        assert Base.url_decode64!(id, padding: false) == <<1, 2, 3>>
      end
    end

    test "an account with no transports hint omits the key rather than sending an empty list", ctx do
      Repo.update_all(Passkey, set: [transports: %{}])

      assert {:ok, %{public_key: options}} =
               WebAuthn.begin_authentication(ctx.user, :second_factor, ctx.binding, "https://irc.example")

      assert [credential] = options.allowCredentials
      refute Map.has_key?(credential, :transports)
    end
  end

  test "passwordless activation persists the pre-shown recovery set only at commit" do
    user = user_fixture()
    current = session_fixture(user)
    other = session_fixture(user)
    codes = Accounts.prepare_recovery_codes()

    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 0
    assert {:ok, "passwordless"} = WebAuthn.set_mode(user, "passwordless", current.id, codes)
    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 10
    assert Repo.get!(Accounts.User, user.id).passkey_mode == "passwordless"
    assert is_nil(Repo.get!(Accounts.Session, current.id).revoked_at)
    assert %DateTime{} = Repo.get!(Accounts.Session, other.id).revoked_at
  end

  test "disabling passkey login removes recovery codes and revokes other sessions" do
    user = user_fixture()
    current = session_fixture(user)
    codes = Accounts.prepare_recovery_codes()

    assert {:ok, "passwordless"} = WebAuthn.set_mode(user, "passwordless", current.id, codes)

    other = session_fixture(user)
    passwordless_user = Repo.get!(Accounts.User, user.id)
    assert {:ok, "disabled"} = WebAuthn.set_mode(passwordless_user, "disabled", current.id)
    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 0
    assert Repo.get!(Accounts.User, passwordless_user.id).passkey_mode == "disabled"
    assert is_nil(Repo.get!(Accounts.Session, current.id).revoked_at)
    assert %DateTime{} = Repo.get!(Accounts.Session, other.id).revoked_at
  end

  test "disabling second-factor passkeys preserves TOTP recovery codes" do
    user = user_fixture()
    current = session_fixture(user)
    codes = Accounts.prepare_recovery_codes()
    :ok = Accounts.RecoveryCodes.replace(user.id, codes)
    user |> Ecto.Changeset.change(passkey_mode: "second_factor") |> Repo.update!()

    second_factor_user = Repo.get!(Accounts.User, user.id)
    assert {:ok, "disabled"} = WebAuthn.set_mode(second_factor_user, "disabled", current.id)
    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 10
  end
end
