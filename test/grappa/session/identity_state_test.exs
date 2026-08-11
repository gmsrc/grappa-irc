defmodule Grappa.Session.IdentityStateTest do
  use ExUnit.Case, async: true

  alias Grappa.Session.IdentityState

  describe "registered_umode/1 — the per-flavour letter" do
    test "defaults to lowercase r (bahamut/Azzurra, and any unclassified network)" do
      assert IdentityState.registered_umode(nil) == "r"
      assert IdentityState.registered_umode(:azzurra) == "r"
      assert IdentityState.registered_umode(:unknown) == "r"
    end

    test "is uppercase R on OFTC" do
      assert IdentityState.registered_umode(:oftc) == "R"
    end

    test "an unrecognised flavour falls back to the lowercase default" do
      assert IdentityState.registered_umode(:some_future_ircd) == "r"
    end
  end

  describe "identified?/1 — umode axis" do
    test "no facts at all reads as not identified" do
      refute IdentityState.identified?(%{})
    end

    test "the flavour's own letter identifies" do
      assert IdentityState.identified?(%{umodes: ["i", "r"], services_flavor: :azzurra})
      assert IdentityState.identified?(%{umodes: ["R", "i"], services_flavor: :oftc})
    end

    test "the letter is EXCLUSIVE per flavour, never a union of r and R" do
      # OFTC's lowercase r is UMODE_REJ (bot-rejection server notices), an
      # oper display mode — NOT identity. Accepting it would mark an oper
      # identified and let the wizard commit a registration that never
      # happened. oftc/oftc-hybrid@36f0431 src/s_user.c:142.
      refute IdentityState.identified?(%{umodes: ["r"], services_flavor: :oftc})

      # Conversely uppercase R is unassigned in solanum core and is NOT
      # bahamut's registered letter, so it must not identify off OFTC.
      refute IdentityState.identified?(%{umodes: ["R"], services_flavor: :azzurra})
      refute IdentityState.identified?(%{umodes: ["R"], services_flavor: :atheme})
      refute IdentityState.identified?(%{umodes: ["R"], services_flavor: nil})
    end

    test "unrelated umodes never identify" do
      refute IdentityState.identified?(%{umodes: ["i", "w", "S"], services_flavor: :azzurra})
    end
  end

  describe "identified?/1 — account axis (flavour-agnostic)" do
    test "a services account identifies with no registered umode in sight" do
      # solanum/atheme (Libera) has no registered umode at all: the account
      # IS the only signal, which is the whole point of #388. That ircd ACKs
      # `account-notify`, and per vjt's ruling of 2026-08-11 the ACK is what
      # makes the account count — so the cap is part of the fixture, not
      # decoration.
      assert IdentityState.identified?(%{
               umodes: [],
               account: "vjt",
               services_flavor: :atheme,
               caps_active: MapSet.new(["account-notify"])
             })
    end

    test "a nil account alone does not identify" do
      refute IdentityState.identified?(%{
               umodes: [],
               account: nil,
               services_flavor: :atheme,
               caps_active: MapSet.new(["account-notify"])
             })
    end

    test "an account without the cap is display only, never proof" do
      # The ruling's narrowing, at the unit. bahamut hands us a 330 but no
      # `account-notify`, so it never promises to retract the account — and
      # a verdict that can go up and never come down is not a verdict.
      refute IdentityState.identified?(%{
               umodes: [],
               account: "vjt",
               services_flavor: :azzurra,
               caps_active: MapSet.new()
             })
    end

    test "the umode axis is untouched by the cap gate" do
      # The gate is on the account axis ALONE: bahamut identifies off `+r`
      # with no cap in sight, exactly as it did before #388.
      assert IdentityState.identified?(%{
               umodes: ["r"],
               account: nil,
               services_flavor: :azzurra,
               caps_active: MapSet.new()
             })
    end

    test "either axis alone suffices — they are OR'd, not AND'd" do
      assert IdentityState.identified?(%{
               umodes: ["r"],
               account: nil,
               services_flavor: :azzurra,
               caps_active: MapSet.new(["account-notify"])
             })

      assert IdentityState.identified?(%{
               umodes: [],
               account: "vjt",
               services_flavor: :azzurra,
               caps_active: MapSet.new(["account-notify"])
             })
    end

    test "a state predating caps_active falls back to the umode axis (#216)" do
      # The hot-reload contract: a process whose state has no `caps_active`
      # key answers "not identified" off the account rather than crashing,
      # and its umode axis still works.
      refute IdentityState.identified?(%{umodes: [], account: "vjt", services_flavor: :atheme})
      assert IdentityState.identified?(%{umodes: ["r"], account: nil, services_flavor: :azzurra})
    end
  end

  describe "normalize_account/1" do
    test "keeps a real account name" do
      assert IdentityState.normalize_account("vjt") == "vjt"
    end

    test "maps the ACCOUNT logout sentinel to nil" do
      # IRCv3 account-notify signals a logout as `ACCOUNT *`.
      assert IdentityState.normalize_account("*") == nil
    end

    test "maps an empty account to nil rather than a blank identity" do
      assert IdentityState.normalize_account("") == nil
    end

    test "passes nil through" do
      assert IdentityState.normalize_account(nil) == nil
    end
  end

  describe "hot-reload tolerance (#216 contract)" do
    test "a state map predating any of the three fields still answers" do
      refute IdentityState.identified?(%{nick: "vjt", network_id: 1})
    end
  end
end
