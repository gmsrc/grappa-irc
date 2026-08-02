defmodule Grappa.Networks.SessionPlanVhostTest do
  @moduledoc """
  #228 / #266 — `Grappa.Networks.SessionPlan.base_plan/7` resolves the
  plan's `source_address` through `Grappa.Vhosts.effective_source/3` (the
  per-subject vhost layer). #266 INVERTS the #251 precedence: an admin-set
  per-network `server.source_address` now WINS over a subject's vhost
  self-selection (Libera go-live: an admin-pinned, accountable egress).
  The per-server source is the value when set; the vhost selection is the
  fallback ONLY when no source is pinned.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, ServerSettings, UserSettings, Vhosts}
  alias Grappa.Net.SourceAliasManager
  alias Grappa.Networks.{Credential, Server, SessionPlan}
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
    {:ok, _} = Vhosts.set_selection({:user, user.id}, [vhost.address], :pool_with_reservations)

    cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
    server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: "2001:db8::99"}

    plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network, server, "n")
    assert plan.source_address == "2001:db8::99"
  end

  test "with a nil server source, a self-selected vhost is used (#266 fallback)" do
    user = user_fixture()
    network = network_fixture()
    {:ok, vhost} = Vhosts.create_vhost(%{address: "2001:db8::def", generally_available: true})
    {:ok, _} = Vhosts.set_selection({:user, user.id}, [vhost.address], :pool_with_reservations)

    cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
    server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: nil}

    plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network, server, "n")
    assert plan.source_address == "2001:db8::def"
    # #543 INC-6 — a mode-1 self-selected vhost is not a derived ::cb alias.
    assert plan.managed_source_alias == nil
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
      # #543 INC-6 — a derived ::cb source is flagged as a managed alias (equal
      # to source_address) so Session.Server acquires/releases it.
      assert plan.managed_source_alias == expected
    end

    test "no grant + no captured client /64 → source_address is {:hold, :no_client_source}" do
      user = user_fixture()
      network = network_fixture()

      cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
      server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: nil}

      plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network, server, "n")
      assert plan.source_address == {:hold, :no_client_source}
      # #543 INC-6 — a {:hold, _} is not a bound source, so no alias to manage.
      assert plan.managed_source_alias == nil
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
      # #543 INC-6 — an admin pin lives OUTSIDE ::cb, so it is never a managed
      # alias (it binds verbatim, no ref-counted lifecycle).
      assert plan.managed_source_alias == nil
    end

    # #647 — the P0 and its real fix (7b880769). A subject with NO recorded
    # UserSettings sample used to HOLD under mode 2, even though its client
    # address was sitting in the visitor row (or the newest sessions row): the
    # sample was captured only at the WS connect, AFTER the anchor spawned, so
    # every FIRST-TIME visitor reached the plan with nothing recorded, was held
    # with :no_client_source, and had its row expired — "no new user can
    # connect". `last_client_prefix64/1` now falls back to that last-known
    # address and derives from it. These pin the resolved source at the exact
    # seam the hold used to strand — the composition (addressing_config →
    # effective_source → last_client_prefix64), which had ZERO end-to-end
    # coverage (the Session.Server hold tests hand-craft `source_address:
    # {:hold, _}` and never reach this path). Falsification target: revert
    # 7b880769 → `last_client_prefix64` returns nil again → {:hold,
    # :no_client_source} → RED.
    test "no sample but a visitor.ip on record → derived from it, NOT held (#647)" do
      client_ip = "2001:db8:11:22:33:44:55:66"
      {:ok, ip_tuple} = :inet.parse_address(String.to_charlist(client_ip))
      # A first-time visitor: the row carries its login `ip`, but NO client
      # sample was ever recorded (the pre-#543 / lost-capture case).
      visitor = visitor_fixture(ip: client_ip)
      refute UserSettings.get_last_client_prefix64({:visitor, visitor.id})

      cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
      server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: nil}

      plan = SessionPlan.base_plan({:visitor, visitor.id}, "label", cred, network_fixture(), server, "n")

      {:ok, expected} = SourceMapping.derive(SourceMapping.client_key(ip_tuple), @cb_prefix)
      assert plan.source_address == expected
      assert SourceMapping.in_prefix?(plan.source_address, @cb_prefix)
      # #543 INC-6 — a derived ::cb source is a managed alias.
      assert plan.managed_source_alias == expected
    end

    test "no sample but a newest sessions.ip on record → derived from it, NOT held (#647, user path)" do
      user = user_fixture()
      client_ip = "2001:db8:aa:bb:cc:dd:ee:ff"
      {:ok, ip_tuple} = :inet.parse_address(String.to_charlist(client_ip))
      # An account whose sample was lost but whose newest session still carries
      # the client address the operator can see in admin.
      {:ok, _} = Accounts.create_session({:user, user.id}, client_ip, nil, [])
      refute UserSettings.get_last_client_prefix64({:user, user.id})

      cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
      server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: nil}

      plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network_fixture(), server, "n")

      {:ok, expected} = SourceMapping.derive(SourceMapping.client_key(ip_tuple), @cb_prefix)
      assert plan.source_address == expected
      assert plan.managed_source_alias == expected
    end

    test "no sample AND no address anywhere → still {:hold, :no_client_source} (Global Constraint)" do
      # The fallback is per-subject and NEVER a shared source: a subject with no
      # sample and no address on record (no visitor.ip, no sessions.ip) is STILL
      # held. 7b880769 widened WHERE the /64 comes from; it did not open a pool
      # fallthrough. Visitor-subject sibling of the user case above. This PASSES
      # both pre- and post-7b880769 — it guards the fix against over-reach.
      visitor = visitor_fixture(ip: nil)
      refute UserSettings.get_last_client_prefix64({:visitor, visitor.id})

      cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
      server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: nil}

      plan = SessionPlan.base_plan({:visitor, visitor.id}, "label", cred, network_fixture(), server, "n")
      assert plan.source_address == {:hold, :no_client_source}
      assert plan.managed_source_alias == nil
    end

    test "resolving via the fallback PERSISTS the sample (walked once per subject, #647)" do
      # 7b880769 records the derived sample on the way through, so the next
      # resolve reads a recorded value instead of re-deriving from the row —
      # the fallback path is walked once per subject, not on every reconnect.
      # Assert the persisted OUTCOME (the sample is now on record), not the call.
      client_ip = "2001:db8:11:22:33:44:55:66"
      {:ok, ip_tuple} = :inet.parse_address(String.to_charlist(client_ip))
      visitor = visitor_fixture(ip: client_ip)
      refute UserSettings.get_last_client_prefix64({:visitor, visitor.id})

      cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
      server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: nil}

      _ = SessionPlan.base_plan({:visitor, visitor.id}, "label", cred, network_fixture(), server, "n")

      assert UserSettings.get_last_client_prefix64({:visitor, visitor.id}) ==
               Base.encode16(SourceMapping.client_key(ip_tuple))
    end
  end
end
