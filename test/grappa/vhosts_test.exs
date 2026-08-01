defmodule Grappa.VhostsTest do
  @moduledoc """
  #228 — `Grappa.Vhosts` context: inventory CRUD, per-subject grants,
  selection (authz-clamped), and the `effective_source/3` resolution
  precedence that feeds the session plan.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures
  import ExUnit.CaptureLog

  alias Grappa.{Repo, UserSettings, Vhosts}
  alias Grappa.UserSettings.Settings
  alias Grappa.Vhosts.SourceMapping

  # #543 INC-4 — addressing configs threaded into `effective_source/3`.
  # Mode 1 (`pool_with_reservations`) is today's behaviour byte-for-byte;
  # mode 2 (`static_mapping_with_reservations`) derives into the `::cb::/80`
  # untrusted block. The `::ca` block below is the OPS-curated reserved
  # block that grants live in — deliberately OUTSIDE `::cb`, so a grant
  # can never collide with a derived address (Global Constraint).
  @cb_prefix "2a03:4000:20:2d3:cb::/80"
  # #543 INC-4 mode-1 ignores the map shape; INC-5 adds `armed?` (the platform
  # arm gate). @mode2 is the ARMED mode-2 config; @mode2_disarmed is the
  # platform-not-ready config that must HOLD with :mode2_disarmed.
  @mode1 %{mode: :pool_with_reservations, prefix: nil, armed?: false}
  @mode2 %{mode: :static_mapping_with_reservations, prefix: @cb_prefix, armed?: true}
  @mode2_disarmed %{mode: :static_mapping_with_reservations, prefix: @cb_prefix, armed?: false}
  # #596 — the bare mode atoms threaded into allowed_vhosts/2, get_selection/2,
  # set_selection/3. The web edge reads them from `ServerSettings.addressing_mode/0`.
  @pool_mode :pool_with_reservations
  @static_mode :static_mapping_with_reservations

  # Unique v6 literal — mask the counter into a single valid hextet
  # (0..0xffff) so the strict-literal changeset always accepts it.
  defp addr do
    n = Bitwise.band(System.unique_integer([:positive]), 0xFFFF)
    "2001:db8::" <> String.downcase(Integer.to_string(n, 16))
  end

  describe "create_vhost/1" do
    test "creates a curated vhost with defaults" do
      {:ok, v} = Vhosts.create_vhost(%{address: "192.0.2.10"})
      assert v.address == "192.0.2.10"
      refute v.in_pool
      refute v.generally_available
    end

    test "canonicalizes the address" do
      {:ok, v} = Vhosts.create_vhost(%{address: "2001:0DB8:0000::0001"})
      assert v.address == "2001:db8::1"
    end

    test "rejects a duplicate address with :already_exists" do
      a = addr()
      {:ok, _} = Vhosts.create_vhost(%{address: a})
      assert {:error, :already_exists} = Vhosts.create_vhost(%{address: a})
    end

    test "rejects a non-literal with a changeset" do
      assert {:error, %Ecto.Changeset{}} = Vhosts.create_vhost(%{address: "not-an-ip"})
    end
  end

  describe "list_vhosts/0 + update_vhost/2 + delete_vhost/1" do
    test "lists all vhosts ordered by address" do
      {:ok, _} = Vhosts.create_vhost(%{address: "192.0.2.2"})
      {:ok, _} = Vhosts.create_vhost(%{address: "192.0.2.1"})
      addrs = Enum.map(Vhosts.list_vhosts(), & &1.address)
      assert "192.0.2.1" in addrs
      assert "192.0.2.2" in addrs
    end

    test "updates availability flags" do
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {:ok, v2} = Vhosts.update_vhost(v, %{in_pool: true, generally_available: true})
      assert v2.in_pool
      assert v2.generally_available
    end

    test "deletes a vhost" do
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      assert :ok = Vhosts.delete_vhost(v)
      refute Enum.any?(Vhosts.list_vhosts(), &(&1.id == v.id))
    end
  end

  describe "grant_vhost/2 + revoke_grant/1" do
    test "grants a vhost to a user subject" do
      user = user_fixture()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {:ok, grant} = Vhosts.grant_vhost(v, {:user, user.id})
      assert grant.vhost_id == v.id
      assert grant.user_id == user.id
    end

    test "grants a vhost to a visitor subject" do
      visitor = visitor_fixture()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {:ok, grant} = Vhosts.grant_vhost(v, {:visitor, visitor.id})
      assert grant.visitor_id == visitor.id
    end

    test "re-granting the same (vhost, subject) is idempotent-ish (:already_exists)" do
      user = user_fixture()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {:ok, _} = Vhosts.grant_vhost(v, {:user, user.id})
      assert {:error, :already_exists} = Vhosts.grant_vhost(v, {:user, user.id})
    end

    test "revoke removes the grant" do
      user = user_fixture()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {:ok, grant} = Vhosts.grant_vhost(v, {:user, user.id})
      assert :ok = Vhosts.revoke_grant(grant)
      assert Vhosts.list_grants_for_subject({:user, user.id}) == []
    end
  end

  describe "allowed_vhosts/2 — mode 1 union of generally-available + in_pool + granted" do
    test "includes generally-available vhosts" do
      user = user_fixture()
      {:ok, ga} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, _} = Vhosts.create_vhost(%{address: addr(), generally_available: false})

      allowed = Enum.map(Vhosts.allowed_vhosts({:user, user.id}, @pool_mode), & &1.id)
      assert ga.id in allowed
    end

    test "includes vhosts granted to the subject but not generally available" do
      user = user_fixture()
      {:ok, granted} = Vhosts.create_vhost(%{address: addr(), generally_available: false})
      {:ok, _} = Vhosts.grant_vhost(granted, {:user, user.id})

      allowed = Enum.map(Vhosts.allowed_vhosts({:user, user.id}, @pool_mode), & &1.id)
      assert granted.id in allowed
    end

    test "excludes a private vhost the subject was never granted" do
      user = user_fixture()
      other = user_fixture()
      {:ok, priv} = Vhosts.create_vhost(%{address: addr(), generally_available: false})
      {:ok, _} = Vhosts.grant_vhost(priv, {:user, other.id})

      allowed = Enum.map(Vhosts.allowed_vhosts({:user, user.id}, @pool_mode), & &1.id)
      refute priv.id in allowed
    end

    # #251 — the pool is seeded `in_pool=1, generally_available=0`, so before
    # this fix a no-grant subject had an EMPTY allow-set ("can't set my vhost").
    # in_pool now joins the allow-set: admin decides AVAILABILITY (pool
    # membership), the user decides SELECTION.
    test "includes in_pool vhosts so a no-grant subject can self-select the pool" do
      user = user_fixture()
      {:ok, pool} = Vhosts.create_vhost(%{address: addr(), in_pool: true, generally_available: false})

      allowed = Enum.map(Vhosts.allowed_vhosts({:user, user.id}, @pool_mode), & &1.id)
      assert pool.id in allowed
    end
  end

  # #596 (part 2) — the allowed (self-selectable) set is mode-dependent. In
  # mode 2 the granted set IS the allowed set: in_pool / generally_available
  # are inert at bind, so offering them for self-selection would let the UI
  # present options that do nothing AND let a write persist an address the
  # resolver drops. The write path + view are clamped to grants, mirroring the
  # bind-time fix.
  describe "allowed_vhosts/2 — mode 2 clamps the selectable set to grants (#596)" do
    test "mode 2 returns ONLY granted vhosts (in_pool + generally-available inert)" do
      user = user_fixture()
      {:ok, ga} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, pool} = Vhosts.create_vhost(%{address: addr(), in_pool: true})
      {:ok, granted} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::d"})
      {:ok, _} = Vhosts.grant_vhost(granted, {:user, user.id})

      mode2 = Enum.map(Vhosts.allowed_vhosts({:user, user.id}, @static_mode), & &1.id)
      assert mode2 == [granted.id]
      refute ga.id in mode2
      refute pool.id in mode2

      # Mode 1 still folds them all in (the #251 union) — same subject.
      mode1 = Enum.map(Vhosts.allowed_vhosts({:user, user.id}, @pool_mode), & &1.id)
      assert ga.id in mode1
      assert pool.id in mode1
      assert granted.id in mode1
    end
  end

  describe "set_selection/3 — authz-clamped to allowed set" do
    test "persists an allowed selection" do
      user = user_fixture()
      {:ok, ga} = Vhosts.create_vhost(%{address: addr(), generally_available: true})

      assert {:ok, [addr]} = Vhosts.set_selection({:user, user.id}, [ga.address], @pool_mode)
      assert addr == ga.address
      assert Vhosts.get_selection({:user, user.id}, @pool_mode) == [ga.address]
    end

    test "rejects a selection outside the allowed set" do
      user = user_fixture()
      {:ok, forbidden} = Vhosts.create_vhost(%{address: addr(), generally_available: false})

      assert {:error, :forbidden_vhost} =
               Vhosts.set_selection({:user, user.id}, [forbidden.address], @pool_mode)
    end

    test "get_selection re-clamps a stale selection whose grant was revoked" do
      user = user_fixture()
      {:ok, granted} = Vhosts.create_vhost(%{address: addr(), generally_available: false})
      {:ok, grant} = Vhosts.grant_vhost(granted, {:user, user.id})
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [granted.address], @pool_mode)

      :ok = Vhosts.revoke_grant(grant)
      # Selection persisted, but the address is no longer allowed → clamped out.
      assert Vhosts.get_selection({:user, user.id}, @pool_mode) == []
    end
  end

  describe "get_selection/2 + set_selection/3 — mode 2 authz clamps to grants (#596)" do
    test "set_selection in mode 2 rejects an in_pool address that is not granted" do
      user = user_fixture()
      {:ok, pool} = Vhosts.create_vhost(%{address: addr(), in_pool: true})

      # Mode 1 allows the write (#251); mode 2 does nothing at bind, so it is
      # rejected at the authz boundary rather than silently kept.
      assert {:ok, _} = Vhosts.set_selection({:user, user.id}, [pool.address], @pool_mode)

      assert {:error, :forbidden_vhost} =
               Vhosts.set_selection({:user, user.id}, [pool.address], @static_mode)
    end

    test "set_selection in mode 2 persists a granted address" do
      user = user_fixture()
      {:ok, granted} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::e"})
      {:ok, _} = Vhosts.grant_vhost(granted, {:user, user.id})

      assert {:ok, [addr]} =
               Vhosts.set_selection({:user, user.id}, [granted.address], @static_mode)

      assert addr == granted.address
    end

    test "get_selection in mode 2 drops a stored non-granted address (selected under mode 1)" do
      user = user_fixture()
      {:ok, pool} = Vhosts.create_vhost(%{address: addr(), in_pool: true})
      {:ok, granted} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::f"})
      {:ok, _} = Vhosts.grant_vhost(granted, {:user, user.id})
      # Persist BOTH under mode 1 (both allowed there).
      {:ok, _} =
        Vhosts.set_selection({:user, user.id}, [pool.address, granted.address], @pool_mode)

      # Mode 2 keeps only the granted one — the in_pool literal drops silently.
      assert Vhosts.get_selection({:user, user.id}, @static_mode) == [granted.address]
      # Mode 1 still sees both.
      assert Enum.sort(Vhosts.get_selection({:user, user.id}, @pool_mode)) ==
               Enum.sort([pool.address, granted.address])
    end
  end

  # #266 — the precedence is INVERTED from #251: an admin-set per-network
  # `server_source` now WINS over the subject's vhost self-selection (and the
  # pool). Libera go-live posture: an admin-pinned, accountable egress is the
  # honest answer; a user-driven rotating vhost reads as ban-evasion. When no
  # admin source is set the vhost selection/pool fallback is unchanged.
  describe "effective_source/3 — mode-1 resolution precedence (#266: admin source wins)" do
    test "1. an admin server_source WINS over an active vhost selection" do
      user = user_fixture()
      {:ok, sel} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [sel.address], @pool_mode)

      # Subject HAS a selection, but the network pins a source → the pin binds.
      assert Vhosts.effective_source({:user, user.id}, "192.0.2.99", @mode1) == "192.0.2.99"
    end

    test "2. falls back to the vhost selection when there is no admin source" do
      user = user_fixture()
      {:ok, sel} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [sel.address], @pool_mode)

      assert Vhosts.effective_source({:user, user.id}, nil, @mode1) == sel.address
    end

    test "2b. multi-selection (no admin source) returns one of the selected (random per connection)" do
      user = user_fixture()
      {:ok, a} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, b} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [a.address, b.address], @pool_mode)

      picked = Vhosts.effective_source({:user, user.id}, nil, @mode1)
      assert picked in [a.address, b.address]
    end

    test "3. an admin server_source binds when there is no selection" do
      user = user_fixture()
      assert Vhosts.effective_source({:user, user.id}, "192.0.2.50", @mode1) == "192.0.2.50"
    end

    test "3b. nil (pool/kernel default) when neither an admin source nor a selection" do
      user = user_fixture()
      assert Vhosts.effective_source({:user, user.id}, nil, @mode1) == nil
    end

    test "a revoked-grant selection does NOT bind — nil admin source falls through to nil" do
      user = user_fixture()
      {:ok, granted} = Vhosts.create_vhost(%{address: addr(), generally_available: false})
      {:ok, grant} = Vhosts.grant_vhost(granted, {:user, user.id})
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [granted.address], @pool_mode)
      :ok = Vhosts.revoke_grant(grant)

      # The clamped-out selection is gone AND there is no admin source → nil.
      assert Vhosts.effective_source({:user, user.id}, nil, @mode1) == nil
    end

    test "mode 1 NEVER derives: a recorded client /64 with no selection still returns nil" do
      # The mode-1 byte-for-byte regression that matters most for #543:
      # a subject WITH a captured client prefix (the mode-2 derive input)
      # must NOT get a derived source in mode 1 — nil still falls through to
      # `OutboundV6Pool.pick/0` at the Client. Enabling capture must not
      # silently change mode-1 egress.
      user = user_fixture()
      :ok = Vhosts.record_client_source({:user, user.id}, {0x2001, 0xDB8, 1, 2, 3, 4, 5, 6})

      assert Vhosts.effective_source({:user, user.id}, nil, @mode1) == nil
    end
  end

  # #543 INC-4 — mode 2 replaces the random pool with a deterministic
  # derivation from the subject's own client /64, with reservations (grants)
  # winning over derivation and NO pool. A missing input HOLDs the session
  # (`{:hold, reason}`) rather than silently egressing from a shared source.
  describe "effective_source/3 — mode-2 static-mapping precedence (#543)" do
    test "an admin server_source WINS even in mode 2 (#266 pin is absolute)" do
      user = user_fixture()
      :ok = Vhosts.record_client_source({:user, user.id}, {0x2001, 0xDB8, 1, 2, 0, 0, 0, 0})

      assert Vhosts.effective_source({:user, user.id}, "2a03:4000:20:2d3:ca::7", @mode2) ==
               "2a03:4000:20:2d3:ca::7"
    end

    test "a grant WINS over derivation — returns a granted address, never a ::cb one" do
      user = user_fixture()
      # Reserved grant address lives OUTSIDE ::cb (in the OPS-curated ::ca
      # block) so it can never collide with a derived address.
      {:ok, reserved} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::5"})
      {:ok, _} = Vhosts.grant_vhost(reserved, {:user, user.id})
      # Even WITH a captured client prefix (the derive input present), the
      # reservation must win.
      :ok = Vhosts.record_client_source({:user, user.id}, {0x2001, 0xDB8, 1, 2, 0, 0, 0, 0})

      picked = Vhosts.effective_source({:user, user.id}, nil, @mode2)
      assert picked == reserved.address
      refute SourceMapping.in_prefix?(picked, @cb_prefix)
    end

    test "multiple grants return one of the granted addresses (random per connection)" do
      user = user_fixture()
      {:ok, a} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::a"})
      {:ok, b} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::b"})
      {:ok, _} = Vhosts.grant_vhost(a, {:user, user.id})
      {:ok, _} = Vhosts.grant_vhost(b, {:user, user.id})

      picked = Vhosts.effective_source({:user, user.id}, nil, @mode2)
      assert picked in [a.address, b.address]
    end

    test "no grant + a known client /64 → the derived address inside ::cb" do
      user = user_fixture()
      client_ip = {0x2001, 0xDB8, 1, 2, 3, 4, 5, 6}
      :ok = Vhosts.record_client_source({:user, user.id}, client_ip)

      picked = Vhosts.effective_source({:user, user.id}, nil, @mode2)

      # Production derivation is the oracle — never a hardcoded byte string.
      {:ok, expected} =
        SourceMapping.derive(SourceMapping.client_key(client_ip), @cb_prefix)

      assert picked == expected
      assert SourceMapping.in_prefix?(picked, @cb_prefix)
    end

    test "no grant + no known client /64 → {:hold, :no_client_source} (never a shared pool)" do
      user = user_fixture()

      assert Vhosts.effective_source({:user, user.id}, nil, @mode2) ==
               {:hold, :no_client_source}
    end

    test "mode 2 with a nil prefix → {:hold, :no_static_prefix} (admin misconfig)" do
      user = user_fixture()
      :ok = Vhosts.record_client_source({:user, user.id}, {0x2001, 0xDB8, 1, 2, 0, 0, 0, 0})

      no_prefix = %{mode: :static_mapping_with_reservations, prefix: nil, armed?: true}

      assert Vhosts.effective_source({:user, user.id}, nil, no_prefix) ==
               {:hold, :no_static_prefix}
    end

    test "mode 2 with a malformed prefix → {:hold, :no_static_prefix} (derive error never falls through)" do
      user = user_fixture()
      :ok = Vhosts.record_client_source({:user, user.id}, {0x2001, 0xDB8, 1, 2, 0, 0, 0, 0})

      bad = %{mode: :static_mapping_with_reservations, prefix: "not-a-cidr", armed?: true}

      assert Vhosts.effective_source({:user, user.id}, nil, bad) ==
               {:hold, :no_static_prefix}
    end

    # #543 INC-5 — the platform arm gate. A disarmed mode 2 (adapter refused to
    # arm: no sudo wrapper, no AnyIP route, Disabled substrate) HOLDs with
    # :mode2_disarmed rather than egressing from a shared kernel-default source
    # (Global Constraint). The gate sits in the NO-GRANT branch: a grant-holder
    # egresses from a curated reserved address that never touches the alias
    # manager, so disarm must NOT block them.
    test "no grant + disarmed → {:hold, :mode2_disarmed} even with a known client /64" do
      user = user_fixture()
      :ok = Vhosts.record_client_source({:user, user.id}, {0x2001, 0xDB8, 1, 2, 3, 4, 5, 6})

      assert Vhosts.effective_source({:user, user.id}, nil, @mode2_disarmed) ==
               {:hold, :mode2_disarmed}
    end

    test "no grant + disarmed → {:hold, :mode2_disarmed} even with no client /64" do
      user = user_fixture()

      assert Vhosts.effective_source({:user, user.id}, nil, @mode2_disarmed) ==
               {:hold, :mode2_disarmed}
    end

    test "a grant WINS over a disarmed platform (reservation needs no alias)" do
      user = user_fixture()
      {:ok, reserved} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::9"})
      {:ok, _} = Vhosts.grant_vhost(reserved, {:user, user.id})

      assert Vhosts.effective_source({:user, user.id}, nil, @mode2_disarmed) == reserved.address
    end

    test "an admin server_source WINS even when disarmed (#266 pin is absolute)" do
      user = user_fixture()

      assert Vhosts.effective_source({:user, user.id}, "2a03:4000:20:2d3:ca::7", @mode2_disarmed) ==
               "2a03:4000:20:2d3:ca::7"
    end

    # Defense-in-depth (#1 Global Constraint): a MALFORMED mode-2 map (missing
    # armed?/prefix) must HOLD, never fall through to the mode-1 shared pool.
    test "a mode-2 map missing armed? HOLDs :mode2_disarmed (never the shared pool)" do
      user = user_fixture()
      :ok = Vhosts.record_client_source({:user, user.id}, {0x2001, 0xDB8, 1, 2, 3, 4, 5, 6})
      no_armed = %{mode: :static_mapping_with_reservations, prefix: @cb_prefix}

      assert Vhosts.effective_source({:user, user.id}, nil, no_armed) == {:hold, :mode2_disarmed}
    end

    test "a mode-2 map missing prefix HOLDs :no_static_prefix when armed (never the pool)" do
      user = user_fixture()
      :ok = Vhosts.record_client_source({:user, user.id}, {0x2001, 0xDB8, 1, 2, 3, 4, 5, 6})
      no_prefix = %{mode: :static_mapping_with_reservations, armed?: true}

      assert Vhosts.effective_source({:user, user.id}, nil, no_prefix) == {:hold, :no_static_prefix}
    end
  end

  # #596 — mode 2 must HONOUR the subject's persisted `vhost_selection`, not
  # random-pick over EVERY grant. Granting a subject the whole reserved pool
  # used to DESTROY their choice: a subject who deliberately picked one address
  # and then received N grants started drawing a fresh random one from all N on
  # every connection (the more availability given, the less the selection meant
  # — the inverse of the intent). Resolution mirrors mode-1's shape with the
  # granted set standing in for the allowed set: (1) selection ∩ granted wins
  # (random among it — "random per connection"); (2) else all granted
  # (availability given, no preference expressed — today's behaviour); (3) else
  # derive-or-hold (unchanged). No branch may return nil / fall through to a
  # shared source (Global Constraint).
  describe "effective_source/3 — mode-2 honours vhost_selection (#596)" do
    test "a single selected grant pins that address, never a random other grant" do
      user = user_fixture()
      {:ok, a} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::a"})
      {:ok, b} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::b"})
      {:ok, c} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::c"})
      for v <- [a, b, c], do: {:ok, _} = Vhosts.grant_vhost(v, {:user, user.id})
      # The subject was granted the WHOLE reserved pool but deliberately picked
      # exactly one — that choice must survive the wide availability.
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [b.address], @static_mode)

      # Every connection binds the selected address — a & c never appear.
      picks = for _ <- 1..50, do: Vhosts.effective_source({:user, user.id}, nil, @mode2)
      assert Enum.uniq(picks) == [b.address]
    end

    test "a multi-selection among grants random-picks WITHIN the selection only" do
      user = user_fixture()
      {:ok, a} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::a"})
      {:ok, b} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::b"})
      {:ok, c} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::c"})
      for v <- [a, b, c], do: {:ok, _} = Vhosts.grant_vhost(v, {:user, user.id})
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [a.address, b.address], @static_mode)

      picks = for _ <- 1..50, do: Vhosts.effective_source({:user, user.id}, nil, @mode2)
      assert Enum.all?(picks, &(&1 in [a.address, b.address]))
      # The unselected grant is never drawn — this is the discriminator that
      # separates "honours selection" from the old "random over all grants".
      refute c.address in picks
    end

    test "a stored selection with NO granted address falls back to all grants" do
      # A selection captured under mode 1 (an in_pool address) that is not in
      # the grant set: selection ∩ granted is empty → step 2 (all grants),
      # never nil / a shared pool.
      user = user_fixture()
      {:ok, pool} = Vhosts.create_vhost(%{address: addr(), in_pool: true})
      {:ok, a} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::a"})
      {:ok, b} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::b"})
      for v <- [a, b], do: {:ok, _} = Vhosts.grant_vhost(v, {:user, user.id})
      # in_pool is in the mode-1 allow-set, so this write persists.
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [pool.address], @pool_mode)

      picks = for _ <- 1..50, do: Vhosts.effective_source({:user, user.id}, nil, @mode2)
      assert Enum.all?(picks, &(&1 in [a.address, b.address]))
      refute pool.address in picks
    end
  end

  # #543 INC-6 — the single decision point that tells `Networks.SessionPlan`
  # whether a resolved source is a DERIVED `::cb` alias the session must
  # acquire/release via `SourceAliasManager`. Keeps the mode+prefix+in_prefix?
  # logic INSIDE Vhosts (SourceMapping stays internal), so Session.Server never
  # re-derives and takes no ServerSettings/Vhosts dep.
  describe "derived_source?/2 — is this source a managed ::cb alias?" do
    test "a mode-2 derived ::cb address is a managed alias" do
      client_ip = {0x2001, 0xDB8, 1, 2, 3, 4, 5, 6}
      {:ok, derived} = SourceMapping.derive(SourceMapping.client_key(client_ip), @cb_prefix)

      assert Vhosts.derived_source?(derived, @mode2)
    end

    test "a mode-2 grant address (outside ::cb) is NOT a managed alias" do
      # Reservations live in the OPS-curated ::ca block — a grant needs no alias.
      refute Vhosts.derived_source?("2a03:4000:20:2d3:ca::5", @mode2)
    end

    test "a mode-1 pool address is NOT a managed alias" do
      refute Vhosts.derived_source?("192.0.2.50", @mode1)
    end

    test "an admin server_source pin (outside ::cb) is NOT a managed alias" do
      # #266 pins are absolute + live outside ::cb, so even under mode 2 the
      # discriminator rejects them.
      refute Vhosts.derived_source?("2a03:4000:20:2d3:ca::7", @mode2)
    end

    test "a nil source is NOT a managed alias" do
      refute Vhosts.derived_source?(nil, @mode2)
    end

    test "a {:hold, _} outcome is NOT a managed alias" do
      refute Vhosts.derived_source?({:hold, :no_client_source}, @mode2)
    end

    test "an in-::cb address under mode 1 is NOT a managed alias (mode gates it)" do
      # Defense-in-depth: only mode 2 produces derived aliases. Even a literal
      # inside ::cb must not be managed under mode 1.
      refute Vhosts.derived_source?("2a03:4000:20:2d3:cb::1", @mode1)
    end

    test "a malformed addressing map (no prefix) is NOT a managed alias" do
      refute Vhosts.derived_source?("2a03:4000:20:2d3:cb::1", %{
               mode: :static_mapping_with_reservations
             })
    end
  end

  describe "granted_vhost_addresses/1" do
    test "returns the addresses of the subject's granted vhosts only" do
      user = user_fixture()
      {:ok, granted} = Vhosts.create_vhost(%{address: "2a03:4000:20:2d3:ca::11"})
      {:ok, _} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, _} = Vhosts.grant_vhost(granted, {:user, user.id})

      addrs = Vhosts.granted_vhost_addresses({:user, user.id})
      assert addrs == [granted.address]
    end

    test "is empty for a subject with no grants" do
      user = user_fixture()
      assert Vhosts.granted_vhost_addresses({:user, user.id}) == []
    end
  end

  describe "pool_addresses/0 — DB-driven rotation set" do
    test "returns only in_pool vhost addresses" do
      {:ok, _} = Vhosts.create_vhost(%{address: addr(), in_pool: true})
      {:ok, out} = Vhosts.create_vhost(%{address: addr(), in_pool: false})

      pool = Vhosts.pool_addresses()
      refute out.address in pool
      assert Enum.all?(pool, &is_binary/1)
    end
  end

  describe "effective_pool/1 — in_pool minus fixed sources (spec §3)" do
    test "subtracts a per-server fixed source that overlaps the pool" do
      {:ok, a} = Vhosts.create_vhost(%{address: addr(), in_pool: true})
      {:ok, b} = Vhosts.create_vhost(%{address: addr(), in_pool: true})

      effective = Vhosts.effective_pool([a.address])
      refute a.address in effective
      assert b.address in effective
    end

    test "a fixed source not in the pool leaves it unchanged" do
      {:ok, a} = Vhosts.create_vhost(%{address: addr(), in_pool: true})

      effective = Vhosts.effective_pool(["2001:db8:ffff::1"])
      assert a.address in effective
    end

    test "an empty fixed-source list is the full in_pool set" do
      {:ok, a} = Vhosts.create_vhost(%{address: addr(), in_pool: true})
      assert a.address in Vhosts.effective_pool([])
    end
  end

  # #543 INC-3 — capture the subject's last-known client /64 at connect so the
  # mode-2 (static_mapping) derivation has a source when no client is attached
  # at upstream-connect. Vhosts owns the domain logic (client_key + base16);
  # UserSettings stays a dumb string store.
  describe "record_client_source/2 + last_client_prefix64/1" do
    test "record_client_source persists the /64 key and last write wins" do
      subject = {:user, user_fixture().id}

      :ok = Vhosts.record_client_source(subject, {0x2001, 0xDB8, 1, 2, 9, 9, 9, 9})
      # Interface id (last 4 hextets) is dropped — the stored key is the /64.
      assert Vhosts.last_client_prefix64(subject) ==
               SourceMapping.client_key({0x2001, 0xDB8, 1, 2, 0, 0, 0, 0})

      # Roam to a different /64 → last write wins.
      :ok = Vhosts.record_client_source(subject, {0x2001, 0xDB8, 1, 3, 0, 0, 0, 0})

      assert Vhosts.last_client_prefix64(subject) ==
               SourceMapping.client_key({0x2001, 0xDB8, 1, 3, 0, 0, 0, 0})
    end

    test "record_client_source stores the /32 for a v4 client" do
      subject = {:user, user_fixture().id}

      :ok = Vhosts.record_client_source(subject, {203, 0, 113, 7})
      assert Vhosts.last_client_prefix64(subject) == SourceMapping.client_key({203, 0, 113, 7})
    end

    test "last_client_prefix64 is nil for a never-seen subject" do
      assert Vhosts.last_client_prefix64({:user, user_fixture().id}) == nil
    end

    test "last_client_prefix64 is nil when the stored value is not valid base16" do
      subject = {:user, user_fixture().id}
      {:ok, settings} = UserSettings.get_or_init(subject)

      # A miscoded writer bypasses the validated putter — a non-empty, non-base16
      # string reaches Vhosts, whose Base.decode16/1 (never decode16!/1) must
      # fall back to nil rather than raise.
      {:ok, _} =
        Repo.update(Settings.changeset(settings, %{data: %{"last_client_prefix64" => "ZZZZ"}}))

      assert Vhosts.last_client_prefix64(subject) == nil
    end

    test "record_client_source returns :ok and LOGS when the subject row is gone" do
      # No backing row → put_last_client_prefix64 returns {:error, cs}. The
      # capture must NEVER fail the connect (returns :ok), but must not silently
      # swallow the error (CLAUDE.md boundary rule → LOGGED).
      subject = {:user, Ecto.UUID.generate()}

      log =
        capture_log(fn ->
          assert :ok = Vhosts.record_client_source(subject, {203, 0, 113, 7})
        end)

      assert log =~ "record_client_source"
      assert Vhosts.last_client_prefix64(subject) == nil
    end

    test "works for visitor subjects (visitor-parity)" do
      subject = {:visitor, visitor_fixture().id}

      :ok = Vhosts.record_client_source(subject, {0x2001, 0xDB8, 0xCAFE, 1, 0, 0, 0, 1})

      assert Vhosts.last_client_prefix64(subject) ==
               SourceMapping.client_key({0x2001, 0xDB8, 0xCAFE, 1, 0, 0, 0, 0})
    end
  end
end
