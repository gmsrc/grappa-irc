defmodule GrappaWeb.ShareTokenTest do
  @moduledoc """
  `GrappaWeb.ShareToken` — the signed share-link payload itself (#1306).

  The payload carries the SUBJECT KIND, not a bare id: `{:visitor, id}`
  / `{:user, id}`. Before #1306 it was the bare UUID, so a visitor id
  and a user id were indistinguishable inside one signed namespace and
  the consume would have had to guess which table to read. These tests
  pin the tag (a token minted for one kind never verifies as the other)
  and pin the salt bump (a `visitor-share-v1` token is refused outright
  rather than silently re-read under the new meaning).

  `async: true` — pure over the endpoint secret, no Repo, no ETS.
  """
  use ExUnit.Case, async: true

  alias GrappaWeb.ShareToken

  # The historical v1 salt + payload shape, frozen here on purpose: this
  # is an artefact of the past, not a re-declaration of production
  # config. Reading it from `ShareToken.salt/0` would make the
  # v1-rejected test vacuous the moment the salt regressed.
  @v1_salt "visitor-share-v1"

  describe "mint/1 + verify/1 round-trip" do
    test "a visitor token verifies back to the tagged visitor subject" do
      id = Ecto.UUID.generate()
      {token, _} = ShareToken.mint({:visitor, id})

      assert {:ok, {:visitor, ^id}} = ShareToken.verify(token)
    end

    test "a user token verifies back to the tagged user subject" do
      id = Ecto.UUID.generate()
      {token, _} = ShareToken.mint({:user, id})

      assert {:ok, {:user, ^id}} = ShareToken.verify(token)
    end

    test "the same id minted for either kind yields subjects that stay distinct" do
      # The substantive #1306 guarantee: the id alone no longer decides
      # which table the consume reads. Two tokens over the SAME uuid
      # recover two DIFFERENT subjects.
      id = Ecto.UUID.generate()
      {visitor_token, _} = ShareToken.mint({:visitor, id})
      {user_token, _} = ShareToken.mint({:user, id})

      assert {:ok, {:visitor, ^id}} = ShareToken.verify(visitor_token)
      assert {:ok, {:user, ^id}} = ShareToken.verify(user_token)
    end

    test "expires_at is max_age_seconds in the future" do
      {_, expires_at} = ShareToken.mint({:user, Ecto.UUID.generate()})

      delta = DateTime.diff(expires_at, DateTime.utc_now())
      assert delta >= ShareToken.max_age_seconds() - 2
      assert delta <= ShareToken.max_age_seconds()
    end
  end

  describe "verify/1 rejections" do
    test "a real v1 token (bare uuid under the old salt) is refused" do
      # The realistic historical artefact: an in-flight link minted
      # before #1306. TWO independent layers refuse it — the salt no
      # longer derives the same key, AND the payload is not a known tag.
      # Measured by mutation: neither the salt nor the shape guard alone
      # can be removed to make this fail, so this test asserts the
      # OUTCOME and attributes it to neither. The two tests below take
      # one layer each; this one is here because it is the input that
      # actually exists in the world.
      v1_token = Phoenix.Token.sign(GrappaWeb.Endpoint, @v1_salt, Ecto.UUID.generate())

      assert {:error, :unauthorized} = ShareToken.verify(v1_token)
    end

    test "a TAGGED payload signed under the v1 salt is refused — this one is the salt" do
      # The discriminator for the salt bump, and the reason it exists as
      # a separate test: the token above is refused by the shape guard
      # even with the salt reverted, so it witnesses nothing about the
      # salt. Give the payload a shape the guard ACCEPTS and the only
      # thing left to refuse it is the signing key. Restore
      # `visitor-share-v1` in production and this — and only this — goes
      # green, which is what makes it the witness.
      forged = Phoenix.Token.sign(GrappaWeb.Endpoint, @v1_salt, {:visitor, Ecto.UUID.generate()})

      assert {:error, :unauthorized} = ShareToken.verify(forged)
    end

    test "a correctly-salted token carrying an untagged payload is refused" do
      # The salt alone is not the guard: anything that reaches the v2
      # namespace still has to present a shape the branch understands.
      untagged =
        Phoenix.Token.sign(GrappaWeb.Endpoint, ShareToken.salt(), Ecto.UUID.generate())

      assert {:error, :unauthorized} = ShareToken.verify(untagged)
    end

    test "a correctly-salted token carrying an unknown kind is refused" do
      forged =
        Phoenix.Token.sign(GrappaWeb.Endpoint, ShareToken.salt(), {:admin, Ecto.UUID.generate()})

      assert {:error, :unauthorized} = ShareToken.verify(forged)
    end

    test "an unsigned string is refused" do
      assert {:error, :unauthorized} = ShareToken.verify("not-a-signed-token")
    end

    test "a token past its TTL reports :share_token_expired, distinctly from :unauthorized" do
      signed_at = System.system_time(:second) - ShareToken.max_age_seconds() - 60

      expired =
        Phoenix.Token.sign(
          GrappaWeb.Endpoint,
          ShareToken.salt(),
          {:visitor, Ecto.UUID.generate()},
          signed_at: signed_at
        )

      assert {:error, :share_token_expired} = ShareToken.verify(expired)
    end
  end
end
