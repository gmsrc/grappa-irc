defmodule Grappa.Networks.CommitPasswordTest do
  @moduledoc """
  #131 — in-session NickServ SET PASSWD capture, user-bound credential
  home. `Credentials.commit_password/3` is the id-keyed write
  Session.Server's `credential_committer` callback invokes when it
  observes a well-formed SET PASSWD leaving the wire (optimistic
  commit-on-send). Mirror of the visitor-side `Visitors.commit_password/2`
  and the sibling id-keyed `update_last_joined_channels/3`.

  Async-safe: each test sets up a unique user/network pair via fixtures.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.{Credential, Credentials}

  defp rotating_credential(attrs) do
    user_with_credential(
      6667,
      Map.merge(%{auth_method: :nickserv_identify, password: "oldpass"}, attrs)
    )
  end

  # The minimum bind attrs each non-`:none` `auth_method` needs to pass the
  # wide changeset's `validate_password_for_auth_method/1`. No catch-all
  # clause on purpose: a SIXTH auth method makes the 2107 guard test below
  # raise FunctionClauseError instead of quietly dropping out of coverage.
  @spec bindable_attrs(Credential.auth_method()) :: map()
  defp bindable_attrs(:server_pass), do: %{auth_method: :server_pass, server_pass: "gatepass"}
  defp bindable_attrs(:sasl), do: %{auth_method: :sasl, sasl_user: "vjt", password: "saslpass"}

  defp bindable_attrs(method) when method in [:auto, :nickserv_identify],
    do: %{auth_method: method, password: "nspass"}

  describe "Credentials.commit_password/3" do
    test "rotates the stored password and round-trips on read (Cloak decrypt)" do
      {_, _, cred} = rotating_credential(%{})
      # password_encrypted carries the DECRYPTED plaintext after load.
      assert cred.password_encrypted == "oldpass"

      assert {:ok, %Credential{}} =
               Credentials.commit_password(cred.user_id, cred.network_id, "newpass")

      assert reload_credential(cred).password_encrypted == "newpass"
    end

    test "preserves every other field — only the password rotates" do
      {_, _, cred} = rotating_credential(%{nick: "vjt", autojoin_channels: ["#grappa", "#italia"]})

      assert {:ok, _} = Credentials.commit_password(cred.user_id, cred.network_id, "newpass")

      reloaded = reload_credential(cred)
      assert reloaded.nick == "vjt"
      assert reloaded.auth_method == :nickserv_identify
      assert reloaded.autojoin_channels == ["#grappa", "#italia"]
      assert reloaded.password_encrypted == "newpass"
    end

    test "stores a rest-of-line password verbatim, spaces included" do
      {_, _, cred} = rotating_credential(%{})

      assert {:ok, _} =
               Credentials.commit_password(cred.user_id, cred.network_id, "my new pass phrase")

      assert reload_credential(cred).password_encrypted == "my new pass phrase"
    end

    test "{:error, :not_found} for an unknown (user, network)" do
      assert {:error, :not_found} =
               Credentials.commit_password(Ecto.UUID.generate(), 999_999, "newpass")
    end
  end

  describe "Credential.password_changeset/2" do
    test "casts and encrypts the new password, touching nothing else" do
      {_, _, cred} = rotating_credential(%{autojoin_channels: ["#grappa"]})

      cs = Credential.password_changeset(cred, "newpass")

      assert cs.valid?
      # The virtual :password is cast; put_encrypted_password copies it into
      # :password_encrypted (Cloak encrypts at the DB boundary on update).
      assert Ecto.Changeset.get_change(cs, :password_encrypted) == "newpass"
      # No other field is touched — autojoin et al. are untouched changes.
      refute Map.has_key?(cs.changes, :autojoin_channels)
      refute Map.has_key?(cs.changes, :nick)
    end

    test "rejects a blank password at the changeset boundary" do
      {_, _, cred} = rotating_credential(%{})

      refute Credential.password_changeset(cred, "").valid?
    end

    test "rejects CR/LF/NUL — the stored value is re-interpolated into the wire" do
      {_, _, cred} = rotating_credential(%{})

      refute Credential.password_changeset(cred, "new\r\npass").valid?
      refute Credential.password_changeset(cred, "new\x00pass").valid?
      # A space still passes HERE: this changeset is network-agnostic and only
      # guards the wire. Azzurra's no-spaces rule is enforced one layer up, at
      # the door that speaks Azzurra (`Session.NSInterceptor`, #977), so a
      # spaced value never reaches this function on the SET PASSWD path.
      assert Credential.password_changeset(cred, "new pass").valid?
    end
  end

  describe "Credentials.commit_registration_password/3" do
    test "commits the password AND flips auth_method :none → :nickserv_identify" do
      {_, _, cred} = rotating_credential(%{auth_method: :none, password: nil})
      assert cred.auth_method == :none
      assert is_nil(cred.password_encrypted)

      assert {:ok, %Credential{}} =
               Credentials.commit_registration_password(cred.user_id, cred.network_id, "regpass")

      reloaded = reload_credential(cred)
      # The whole point vs commit_password/3: BOTH the password lands AND the
      # binding is promoted to auto-identify (else the registered nick gets
      # services-enforced on the next reconnect).
      assert reloaded.password_encrypted == "regpass"
      assert reloaded.auth_method == :nickserv_identify
    end

    test "preserves nick + autojoin — only password + auth_method change" do
      {_, _, cred} =
        rotating_credential(%{
          auth_method: :none,
          password: nil,
          nick: "wizreg",
          autojoin_channels: ["#bofh"]
        })

      assert {:ok, _} =
               Credentials.commit_registration_password(cred.user_id, cred.network_id, "regpass")

      reloaded = reload_credential(cred)
      assert reloaded.nick == "wizreg"
      assert reloaded.autojoin_channels == ["#bofh"]
    end

    test "{:error, :not_found} for an unknown (user, network)" do
      assert {:error, :not_found} =
               Credentials.commit_registration_password(Ecto.UUID.generate(), 999_999, "regpass")
    end

    # issue 2107 — reported by morph: registering a nick flipped a
    # `:server_pass` credential to `:nickserv_identify`, and the REST surface
    # had no way back. The promotion is for `--auth none` bindings (the
    # docstring says so); on a row that already declares how it authenticates,
    # the REGISTER password lands and the method stays put.
    test "does NOT stomp a :server_pass binding — the +r flip is :none-only" do
      {_, _, cred} =
        user_with_credential(6667, %{auth_method: :server_pass, server_pass: "gatepass"})

      assert {:ok, %Credential{}} =
               Credentials.commit_registration_password(cred.user_id, cred.network_id, "regpass")

      assert reload_credential(cred).auth_method == :server_pass
    end

    test "still lands the REGISTER password on a :server_pass binding" do
      {_, _, cred} =
        user_with_credential(6667, %{auth_method: :server_pass, server_pass: "gatepass"})

      assert {:ok, %Credential{}} =
               Credentials.commit_registration_password(cred.user_id, cred.network_id, "regpass")

      reloaded = reload_credential(cred)
      assert reloaded.password_encrypted == "regpass"
      # The gate secret lives in its own #1044 slot and is not collateral.
      assert reloaded.server_pass_encrypted == "gatepass"
    end

    test "does NOT stomp a :sasl binding either — the guard is on the VALUE" do
      {_, _, cred} =
        user_with_credential(6667, %{auth_method: :sasl, sasl_user: "vjt", password: "saslpass"})

      assert {:ok, %Credential{}} =
               Credentials.commit_registration_password(cred.user_id, cred.network_id, "regpass")

      assert reload_credential(cred).auth_method == :sasl
    end
  end

  describe "Credential.registration_changeset/2" do
    test "casts the password + flips auth_method, encrypts, touching nothing else" do
      {_, _, cred} =
        rotating_credential(%{auth_method: :none, password: nil, autojoin_channels: ["#grappa"]})

      cs = Credential.registration_changeset(cred, "regpass")

      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :password_encrypted) == "regpass"
      assert Ecto.Changeset.get_change(cs, :auth_method) == :nickserv_identify
      refute Map.has_key?(cs.changes, :autojoin_channels)
      refute Map.has_key?(cs.changes, :nick)
    end

    test "rejects a blank password at the changeset boundary" do
      {_, _, cred} = rotating_credential(%{auth_method: :none, password: nil})

      refute Credential.registration_changeset(cred, "").valid?
    end

    test "rejects CR/LF/NUL — the password is re-interpolated into IDENTIFY" do
      {_, _, cred} = rotating_credential(%{auth_method: :none, password: nil})

      refute Credential.registration_changeset(cred, "re\r\ngpass").valid?
      refute Credential.registration_changeset(cred, "re\x00gpass").valid?
      # A space is legal (rest-of-line password).
      assert Credential.registration_changeset(cred, "reg pass").valid?
    end

    # issue 2107 — the sibling promotion door
    # (`Credentials.update_credential_password/2`) has always been `:none`-gated;
    # this one was not, and that asymmetry is the defect. Asserting on
    # `changes` rather than `get_field` is deliberate: the row must be left
    # UNWRITTEN, not merely written with the same value.
    test "promotes :none, and ONLY :none, to :nickserv_identify" do
      {_, _, anon} = rotating_credential(%{auth_method: :none, password: nil})

      assert Ecto.Changeset.get_change(
               Credential.registration_changeset(anon, "regpass"),
               :auth_method
             ) == :nickserv_identify

      for method <- Credential.auth_methods(), method != :none do
        {_, _, cred} = rotating_credential(bindable_attrs(method))
        cs = Credential.registration_changeset(cred, "regpass")

        assert cs.valid?, "#{method}: #{inspect(errors_on(cs))}"
        refute Map.has_key?(cs.changes, :auth_method), "#{method}: auth_method was stomped"
      end
    end
  end
end
