defmodule Grappa.Networks.SessionPlanVhostTest do
  @moduledoc """
  #228 / #266 — `Grappa.Networks.SessionPlan.base_plan/7` resolves the
  plan's `source_address` through `Grappa.Vhosts.effective_source/2` (the
  per-subject vhost layer). #266 INVERTS the #251 precedence: an admin-set
  per-network `server.source_address` now WINS over a subject's vhost
  self-selection (Libera go-live: an admin-pinned, accountable egress).
  The per-server source is the value when set; the vhost selection is the
  fallback ONLY when no source is pinned.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Net.SourceAliasManager
  alias Grappa.Networks.{Credential, Server, SessionPlan}
  alias Grappa.{ServerSettings, Vhosts}
  alias Grappa.Vhosts.SourceMapping

  test "with no pin / no selection, source_address falls back to server.source_address" do
    user = user_fixture()
    network = network_fixture()
    cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
    server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: "2001:db8::99"}

    plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network, server, "n")
    assert plan.source_address == "2001:db8::99"
  end

  test "with a nil server source and no vhost config, source_address is nil" do
    user = user_fixture()
    network = network_fixture()
    cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
    server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: nil}

    plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network, server, "n")
    assert plan.source_address == nil
  end

  test "an admin server source WINS over a self-selected vhost (#266)" do
    user = user_fixture()
    network = network_fixture()
    {:ok, vhost} = Vhosts.create_vhost(%{address: "2001:db8::def", generally_available: true})
    {:ok, _} = Vhosts.set_selection({:user, user.id}, [vhost.address])

    cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
    server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: "2001:db8::99"}

    plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network, server, "n")
    assert plan.source_address == "2001:db8::99"
  end

  test "with a nil server source, a self-selected vhost is used (#266 fallback)" do
    user = user_fixture()
    network = network_fixture()
    {:ok, vhost} = Vhosts.create_vhost(%{address: "2001:db8::def", generally_available: true})
    {:ok, _} = Vhosts.set_selection({:user, user.id}, [vhost.address])

    cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
    server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: nil}

    plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network, server, "n")
    assert plan.source_address == "2001:db8::def"
  end

  # #543 INC-4 — in `static_mapping_with_reservations` mode, `base_plan`
  # reads the addressing config (mode + prefix) from `ServerSettings` ONCE
  # and threads it into `effective_source/3`. The default mode is
  # `pool_with_reservations`, so the four tests above already exercise
  # mode-1 byte-for-byte without touching `ServerSettings`.
  @cb_prefix "2a03:4000:20:2d3:cb::/80"

  describe "base_plan source_address in static_mapping mode (#543)" do
    setup do
      :ok = ServerSettings.put_addressing_mode(:static_mapping_with_reservations)
      :ok = ServerSettings.put_static_mapping_prefix(@cb_prefix)
      # #543 INC-5 — arm the platform so the addressing config's arm gate lets
      # the derive/hold path run. Without this, base_plan reads the test app's
      # (Disabled-adapter, disarmed) manager and every mode-2 plan HOLDs with
      # :mode2_disarmed BEFORE reaching :no_client_source. Reset on exit so the
      # armed state never leaks to a sibling test (persistent_term is global).
      :ok = SourceAliasManager.put_test_armed(true, nil)
      on_exit(fn -> SourceAliasManager.put_test_armed(false, :not_armed) end)
      :ok
    end

    test "no grant + a captured client /64 → a derived ::cb source_address" do
      user = user_fixture()
      network = network_fixture()
      client_ip = {0x2001, 0xDB8, 1, 2, 3, 4, 5, 6}
      :ok = Vhosts.record_client_source({:user, user.id}, client_ip)

      cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
      server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: nil}

      plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network, server, "n")

      {:ok, expected} = SourceMapping.derive(SourceMapping.client_key(client_ip), @cb_prefix)
      assert plan.source_address == expected
      assert SourceMapping.in_prefix?(plan.source_address, @cb_prefix)
    end

    test "no grant + no captured client /64 → source_address is {:hold, :no_client_source}" do
      user = user_fixture()
      network = network_fixture()

      cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
      server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: nil}

      plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network, server, "n")
      assert plan.source_address == {:hold, :no_client_source}
    end

    test "an admin server source still WINS over a hold (#266 pin absolute)" do
      user = user_fixture()
      network = network_fixture()

      # No captured client /64 — mode 2 would HOLD, but a pinned per-network
      # source is absolute and must bind verbatim.
      cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
      server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: "2001:db8::99"}

      plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network, server, "n")
      assert plan.source_address == "2001:db8::99"
    end
  end
end
