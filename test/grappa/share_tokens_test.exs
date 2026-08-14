defmodule Grappa.ShareTokensTest do
  @moduledoc """
  ETS-backed one-shot consumption set for share-token IDs.

  The actual Phoenix.Token signing / verification stays in
  `GrappaWeb.ShareToken` — this module is the "has this token already
  been redeemed?" ledger. Two devices clicking the same share link race
  here. Kind-agnostic by construction: the key is the token string
  (#1306 needed no change here, only the honest name).

  `async: false` because the ShareTokens GenServer + ETS table is a
  module-singleton (named-table), shared across the whole suite.
  """
  use ExUnit.Case, async: false

  alias Grappa.ShareTokens

  setup do
    # Fresh table state per test — clear all entries.
    for key <- ShareTokens.all_keys(), do: :ets.delete(:share_tokens_used, key)
    :ok
  end

  describe "mark_consumed/1" do
    test "first call returns :ok" do
      assert :ok = ShareTokens.mark_consumed("token-a")
    end

    test "second call with same token returns {:error, :already_consumed}" do
      :ok = ShareTokens.mark_consumed("token-b")
      assert {:error, :already_consumed} = ShareTokens.mark_consumed("token-b")
    end

    test "distinct tokens are independent" do
      assert :ok = ShareTokens.mark_consumed("token-c")
      assert :ok = ShareTokens.mark_consumed("token-d")
    end

    test "concurrent attempts on same token: exactly one :ok, rest :already_consumed" do
      token = "token-race"

      results =
        1..50
        |> Task.async_stream(fn _ -> ShareTokens.mark_consumed(token) end, max_concurrency: 50)
        |> Enum.map(fn {:ok, r} -> r end)

      oks = Enum.count(results, &(&1 == :ok))
      errs = Enum.count(results, &(&1 == {:error, :already_consumed}))

      assert oks == 1
      assert errs == 49
    end
  end

  describe "release/1" do
    # #593 — the compensating action for claim-then-release. A consume
    # claims the token (mark_consumed) BEFORE the session mint; a failed
    # mint must roll that claim back so the retryable-503 the client is
    # invited to retry can actually succeed.
    test "deletes a consumed token so a later mark_consumed succeeds again" do
      :ok = ShareTokens.mark_consumed("token-rel")
      assert {:error, :already_consumed} = ShareTokens.mark_consumed("token-rel")

      assert :ok = ShareTokens.release("token-rel")
      # The claim is gone: the token is once again claimable.
      assert :ok = ShareTokens.mark_consumed("token-rel")
    end

    test "releasing a token that was never consumed is a harmless no-op" do
      assert :ok = ShareTokens.release("never-claimed")
      # Still fully claimable afterwards — the no-op didn't corrupt the set.
      assert :ok = ShareTokens.mark_consumed("never-claimed")
    end
  end

  describe "table_name/0" do
    test "returns the named ETS table atom" do
      assert ShareTokens.table_name() == :share_tokens_used
    end
  end
end
