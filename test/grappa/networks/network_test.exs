defmodule Grappa.Networks.NetworkTest do
  use Grappa.DataCase, async: true

  alias Grappa.Networks.Network

  describe "changeset/2" do
    test "accepts max_concurrent_visitor_sessions and max_per_ip" do
      attrs = %{slug: "testnet", max_concurrent_visitor_sessions: 10, max_per_ip: 2}
      changeset = Network.changeset(%Network{}, attrs)

      assert changeset.valid?
      assert Ecto.Changeset.get_change(changeset, :max_concurrent_visitor_sessions) == 10
      assert Ecto.Changeset.get_change(changeset, :max_per_ip) == 2
    end

    test "both cap fields are optional (nil = uncapped / inherit default)" do
      changeset = Network.changeset(%Network{}, %{slug: "testnet"})
      assert changeset.valid?
    end

    test "rejects negative max_concurrent_visitor_sessions" do
      changeset = Network.changeset(%Network{}, %{slug: "testnet", max_concurrent_visitor_sessions: -1})
      refute changeset.valid?
      assert "must be non-negative integer or nil" in errors_on(changeset).max_concurrent_visitor_sessions
    end

    test "rejects negative max_concurrent_user_sessions" do
      changeset = Network.changeset(%Network{}, %{slug: "testnet", max_concurrent_user_sessions: -1})
      refute changeset.valid?
      assert "must be non-negative integer or nil" in errors_on(changeset).max_concurrent_user_sessions
    end

    test "rejects negative max_per_ip" do
      changeset = Network.changeset(%Network{}, %{slug: "testnet", max_per_ip: -1})
      refute changeset.valid?
      assert "must be non-negative integer or nil" in errors_on(changeset).max_per_ip
    end

    test "accepts zero (degenerate lock-down — explicit 'allow none')" do
      changeset =
        Network.changeset(%Network{}, %{slug: "testnet", max_concurrent_visitor_sessions: 0, max_per_ip: 0})

      assert changeset.valid?
      assert Ecto.Changeset.get_change(changeset, :max_concurrent_visitor_sessions) == 0
      assert Ecto.Changeset.get_change(changeset, :max_per_ip) == 0
    end

    test "accepts nil to clear an existing cap" do
      base = %Network{slug: "testnet", max_concurrent_visitor_sessions: 5, max_per_ip: 3}
      changeset = Network.changeset(base, %{max_concurrent_visitor_sessions: nil})

      assert changeset.valid?
      assert Ecto.Changeset.get_change(changeset, :max_concurrent_visitor_sessions) == nil
    end
  end

  describe "services_flavor (GH #349 registration wizard)" do
    for flavor <- [:azzurra, :atheme, :oftc, :unknown] do
      test "casts #{flavor} (atom and string)" do
        cs_atom = Network.changeset(%Network{}, %{slug: "testnet", services_flavor: unquote(flavor)})
        assert cs_atom.valid?
        assert Ecto.Changeset.get_change(cs_atom, :services_flavor) == unquote(flavor)

        cs_str =
          Network.changeset(%Network{}, %{slug: "testnet", services_flavor: unquote(to_string(flavor))})

        assert cs_str.valid?
        assert Ecto.Changeset.get_change(cs_str, :services_flavor) == unquote(flavor)
      end
    end

    test "rejects a value outside the closed set (reject-at-boundary)" do
      cs = Network.changeset(%Network{}, %{slug: "testnet", services_flavor: "suxserv"})
      refute cs.valid?
      assert %{services_flavor: [_ | _]} = errors_on(cs)
    end

    test "is optional — nil == unclassified (wizard hidden)" do
      cs = Network.changeset(%Network{}, %{slug: "testnet"})
      assert cs.valid?
      assert Ecto.Changeset.get_field(cs, :services_flavor) == nil
    end

    test "accepts nil to clear an existing flavor" do
      base = %Network{slug: "testnet", services_flavor: :azzurra}
      cs = Network.changeset(base, %{services_flavor: nil})
      assert cs.valid?
      assert Ecto.Changeset.get_field(cs, :services_flavor) == nil
    end
  end

  describe "visitor_enabled (#211 phase 1 runtime allowlist)" do
    test "defaults to false (visitors disabled per-network — play safe)" do
      # The schema default mirrors the DB column default so a freshly
      # cast Network struct matches the persisted row (no nil-divergence).
      assert %Network{}.visitor_enabled == false
    end

    test "changeset casts visitor_enabled true" do
      changeset = Network.changeset(%Network{}, %{slug: "testnet", visitor_enabled: true})
      assert changeset.valid?
      assert Ecto.Changeset.get_change(changeset, :visitor_enabled) == true
    end

    test "visitor_enabled is optional (omitted keeps the false default)" do
      changeset = Network.changeset(%Network{}, %{slug: "testnet"})
      assert changeset.valid?
      assert Ecto.Changeset.get_field(changeset, :visitor_enabled) == false
    end
  end
end
