defmodule Grappa.Networks.AwayTest do
  @moduledoc """
  GH #417 — tests for the persisted EXPLICIT away snapshot
  (`away_reason` / `away_since` on `network_credentials`) that survives a
  session crash / `:transient` respawn / upstream reconnect.

  Three surfaces under test (the end-to-end restore + re-send-upstream
  behaviour lives in `Grappa.Session.ServerTest`'s away describe block):

    1. `Credentials.update_away/4` — id-keyed write used by
       Session.Server's `away_persister` closure. Sets the pair, clears
       it on `(nil, nil)`, `{:error, :not_found}` for an unknown subject.
    2. `Credential.away_changeset/3` — the narrow changeset + its
       `safe_line_token` wire-hygiene guard on `away_reason`.
    3. `SessionPlan.resolve/1` — threads the DB snapshot into the plan as
       `restored_away` + injects the `away_persister` closure (user-only).

  Async-safe: each test provisions a unique user/network via fixtures, so
  Repo sandbox isolation holds.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.{Credential, Credentials, SessionPlan}
  alias Grappa.Repo

  defp setup_credential(attrs \\ %{}) do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: 6667, slug: "test-#{System.unique_integer([:positive])}")

    cred = credential_fixture(user, network, attrs)
    {user, network, cred}
  end

  defp reload(%Credential{} = cred) do
    Repo.get_by!(Credential, user_id: cred.user_id, network_id: cred.network_id)
  end

  describe "Credentials.update_away/4" do
    test "writes reason + since and round-trips on read" do
      {_, _, cred} = setup_credential()
      assert cred.away_reason == nil
      assert cred.away_since == nil

      since = DateTime.utc_now()
      assert :ok = Credentials.update_away(cred.user_id, cred.network_id, "lunch", since)

      reloaded = reload(cred)
      assert reloaded.away_reason == "lunch"
      # usec precision preserved (:utc_datetime_usec) — verbatim round-trip
      # is load-bearing for the mentions-window honesty.
      assert reloaded.away_since == since
    end

    test "clears the pair on (nil, nil) — the /back path" do
      {_, _, cred} = setup_credential()
      :ok = Credentials.update_away(cred.user_id, cred.network_id, "gone", DateTime.utc_now())
      assert reload(cred).away_reason == "gone"

      assert :ok = Credentials.update_away(cred.user_id, cred.network_id, nil, nil)

      reloaded = reload(cred)
      assert reloaded.away_reason == nil
      assert reloaded.away_since == nil
    end

    test "{:error, :not_found} for an unknown (user, network)" do
      assert {:error, :not_found} =
               Credentials.update_away(Ecto.UUID.generate(), 999_999, "x", DateTime.utc_now())
    end
  end

  describe "Credential.away_changeset/3 wire-hygiene guard" do
    # away_reason is re-interpolated into `AWAY :<reason>` on reconnect, so
    # a CR/LF/NUL byte would split or truncate the outbound frame. The
    # `Session.set_explicit_away/3` facade already guards user input; this
    # is the OTHER door (defense-in-depth).
    test "rejects a reason carrying CR/LF/NUL" do
      {_, _, cred} = setup_credential()

      for bad <- ["ha\r\nQUIT", "a\nb", "nul\0byte"] do
        cs = Credential.away_changeset(cred, bad, DateTime.utc_now())
        refute cs.valid?, "expected #{inspect(bad)} to be rejected"
        assert cs.errors[:away_reason]
      end
    end

    test "accepts a rest-of-line reason with spaces" do
      {_, _, cred} = setup_credential()
      cs = Credential.away_changeset(cred, "out for lunch, back at 2pm", DateTime.utc_now())
      assert cs.valid?
    end

    test "the clear changeset (nil, nil) is valid" do
      {_, _, cred} = setup_credential()
      assert Credential.away_changeset(cred, nil, nil).valid?
    end
  end

  describe "SessionPlan.resolve/1 away restore threading" do
    test "resolved plan carries restored_away = {reason, since} when persisted" do
      {_, _, cred} = setup_credential()
      since = DateTime.utc_now()
      :ok = Credentials.update_away(cred.user_id, cred.network_id, "brb", since)

      {:ok, plan} = SessionPlan.resolve(reload(cred))

      assert plan.restored_away == {"brb", since}
      # Persister injected for the user subject (Boundary-clean closure).
      assert is_function(plan.away_persister, 2)
    end

    test "resolved plan restored_away is nil when not away" do
      {_, _, cred} = setup_credential()

      {:ok, plan} = SessionPlan.resolve(reload(cred))

      assert plan.restored_away == nil
    end
  end
end
