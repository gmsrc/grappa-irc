defmodule Grappa.Vhosts.SourceMappingKeyTest do
  @moduledoc """
  #1404 — the mode-2 outbound address is a KEYED function of the client
  prefix, and the derivation is pinned so it cannot move in silence.

  Separate module from `SourceMappingTest` because these cases swap the
  deployment key, which lives in `:persistent_term` and is therefore
  node-global: `async: false`, and every case restores the key
  `Grappa.Application.start/2` installed.

  Why a separate FILE and not more cases over there: every test in
  `SourceMappingTest` asserts a RELATIVE property — determinism, two
  inputs differing, the network bits staying put — and all of them hold
  just as well under an unkeyed hash, or under any future derivation
  someone swaps in. That was measured before this change and it is the
  gap this file closes.
  """

  use ExUnit.Case, async: false

  alias Grappa.Vhosts.SourceMapping

  @prefix "2a03:4000:20:2d3:cb::/80"

  # A client `/64` and a client `/32`, as `client_key/1` reduces them.
  @client_v6 {0x2001, 0xDB8, 1, 2, 0xAAAA, 0xBBBB, 0xCCCC, 0xDDDD}
  @client_v4 {203, 0, 113, 7}

  # Fixed deployment secrets, so a case reads the same on every host.
  @secret "w1-1404-source-mapping-pin-secret"
  @other_secret "a-different-deployment-entirely"

  setup do
    booted = Application.get_env(:grappa, GrappaWeb.Endpoint, [])[:secret_key_base]
    # Restore what the application installed, not a value of our own: a
    # test that leaves a foreign key behind renumbers every later case.
    on_exit(fn -> :ok = SourceMapping.boot(booted) end)
    :ok
  end

  defp derive!(secret, client) do
    :ok = SourceMapping.boot(secret)
    {:ok, addr} = SourceMapping.derive(SourceMapping.client_key(client), @prefix)
    addr
  end

  describe "the derivation is keyed to the deployment" do
    test "two deployments derive DIFFERENT addresses for the same client" do
      ours = derive!(@secret, @client_v6)
      theirs = derive!(@other_secret, @client_v6)

      # This is the whole property: the address is a function of the
      # client AND the deployment, so it is ours and not the code's.
      refute ours == theirs,
             "the same client derived #{ours} under both deployment keys — the derivation is not keyed"

      # Keying must not have cost the properties mode 2 relies on.
      assert SourceMapping.in_prefix?(ours, @prefix)
      assert SourceMapping.in_prefix?(theirs, @prefix)
    end

    test "a deployment derives the SAME address for the same client, every time" do
      # Determinism across a re-boot of the key, not merely across two
      # calls: the key is derived from the secret at boot, so a
      # non-deterministic derivation step would surface here and nowhere
      # else.
      assert derive!(@secret, @client_v6) == derive!(@secret, @client_v6)
      assert derive!(@secret, @client_v4) == derive!(@secret, @client_v4)
    end
  end

  describe "the derived value is pinned" do
    # Changing the derivation renumbers every subject on a live mode-2
    # deployment at their next connect. That is a supported event — it is
    # what a prefix renumber does — but it must be a DECISION. Before
    # this pin existed, swapping the hash passed green and the operator
    # found out from the alias churn.
    #
    # Regenerating these after a deliberate change: boot the same secret
    # and read what `derive/2` returns. Do not hand-edit a digit.
    test "a v6 /64 derives its pinned address" do
      assert derive!(@secret, @client_v6) == "2a03:4000:20:2d3:cb:fa3:3b49:9720"
    end

    test "a v4 /32 derives its pinned address" do
      assert derive!(@secret, @client_v4) == "2a03:4000:20:2d3:cb:83b:b8d6:126f"
    end
  end

  describe "an unbooted node refuses to derive" do
    test "derive raises rather than deriving without a deployment key" do
      :persistent_term.erase({SourceMapping, :mac_key})

      # The one seam in the codebase with no default. Every other
      # `:persistent_term` reader degrades gracefully; here the only
      # fallback available is a compiled-in constant, which is not a key —
      # so absence has to be loud.
      assert_raise ArgumentError, fn ->
        SourceMapping.derive(SourceMapping.client_key(@client_v6), @prefix)
      end
    end
  end
end
