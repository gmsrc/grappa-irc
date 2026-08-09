defmodule Grappa.Net.HostAddressesTest do
  @moduledoc """
  #228 — host-bound address enumeration. The admin vhost picker draws
  candidate addresses from the host itself (`:inet.getifaddrs/0`), NOT an
  env var (vjt decision 2026-07-14): the DB curates which of the host's
  real addresses become vhosts, so the source of "what CAN be bound" is
  the kernel's interface table. Inside the m42 bastille jail this returns
  exactly the jail's assigned IPs — the true bindable universe, no drift.

  Loopback + link-local are filtered: you can never egress IRC from
  `127.0.0.1` / `::1` / `169.254.x` / `fe80::`, so surfacing them is a
  footgun. The pure classification (`egressable?/1`) is unit-tested
  directly; the live `list/0` is smoke-tested for shape only (the host's
  actual addresses are environment-dependent).
  """
  use ExUnit.Case, async: true

  alias Grappa.Net.HostAddresses

  describe "egressable?/1 — v4" do
    test "loopback 127.0.0.1 is not egressable" do
      refute HostAddresses.egressable?({127, 0, 0, 1})
    end

    test "anywhere in 127/8 is not egressable" do
      refute HostAddresses.egressable?({127, 5, 5, 5})
    end

    test "link-local 169.254.x.x is not egressable" do
      refute HostAddresses.egressable?({169, 254, 1, 2})
    end

    test "a routable public v4 is egressable" do
      assert HostAddresses.egressable?({192, 0, 2, 1})
    end

    test "an RFC1918 private v4 is egressable (jail/LAN egress is legit)" do
      assert HostAddresses.egressable?({10, 0, 0, 5})
    end
  end

  describe "egressable?/1 — v6" do
    test "loopback ::1 is not egressable" do
      refute HostAddresses.egressable?({0, 0, 0, 0, 0, 0, 0, 1})
    end

    test "link-local fe80::/10 is not egressable" do
      refute HostAddresses.egressable?({0xFE80, 0, 0, 0, 0, 0, 0, 1})
    end

    test "a global-unicast v6 (2001:db8::1) is egressable" do
      assert HostAddresses.egressable?({0x2001, 0x0DB8, 0, 0, 0, 0, 0, 1})
    end

    test "a ULA fc00::/7 v6 is egressable" do
      assert HostAddresses.egressable?({0xFD00, 0, 0, 0, 0, 0, 0, 1})
    end
  end

  describe "list/0" do
    test "returns a list of canonical IP-literal strings, none loopback" do
      addrs = HostAddresses.list()
      assert is_list(addrs)
      assert Enum.all?(addrs, &is_binary/1)
      # Whatever the host has, loopback must never appear.
      refute "127.0.0.1" in addrs
      refute "::1" in addrs
      # Every returned entry round-trips as a strict literal.
      assert Enum.all?(addrs, fn a -> match?({:ok, ^a}, Grappa.Net.IpLiteral.canonicalize(a)) end)
    end
  end

  # #266 — the admin per-network source-address gate. The universe is passed
  # IN (deterministic; no dependence on the host's real interfaces), so these
  # are pure and stable in any container.
  describe "local_bindable?/2" do
    # Threat first: a valid literal that the host does NOT bind is rejected.
    # 192.0.2.1 is TEST-NET-1 (RFC 5737) — never an interface address.
    test "a non-local literal is NOT bindable (threat)" do
      refute HostAddresses.local_bindable?("192.0.2.1", ["203.0.113.5", "2001:db8::1"])
    end

    test "a local literal in the set IS bindable" do
      assert HostAddresses.local_bindable?("203.0.113.5", ["203.0.113.5", "2001:db8::1"])
    end

    test "canonicalizes before comparing (2001:0DB8::1 matches stored 2001:db8::1)" do
      assert HostAddresses.local_bindable?("2001:0DB8::0001", ["2001:db8::1"])
    end

    test "a non-literal (hostname/garbage) is NOT bindable" do
      refute HostAddresses.local_bindable?("not-an-ip", ["203.0.113.5"])
      refute HostAddresses.local_bindable?("example.com", ["203.0.113.5"])
    end

    test "an empty universe binds nothing" do
      refute HostAddresses.local_bindable?("203.0.113.5", [])
    end
  end

  # #1157 — under the #543 `static_mapping_with_reservations` mode every
  # derived source is bound as a real `/128` alias on `lo0`, so
  # `getifaddrs/0` hands them back and the operator's vhost picker fills
  # with addresses nobody curated. Same shape as `local_bindable?/2`: the
  # universe AND the prefix are passed IN, so this is deterministic
  # wherever it runs.
  describe "reject_in_prefix/2" do
    @prefix "2a03:4000:20:2d3:cafe::/80"

    test "drops an address inside the prefix" do
      universe = ["2a03:4000:20:2d3:cafe::5", "2a03:4000:20:2d3::1"]

      refute "2a03:4000:20:2d3:cafe::5" in HostAddresses.reject_in_prefix(universe, @prefix)
    end

    test "keeps a v6 address outside the prefix" do
      assert HostAddresses.reject_in_prefix(["2a03:4000:20:2d3::1"], @prefix) ==
               ["2a03:4000:20:2d3::1"]
    end

    test "keeps every v4 address — a v6 prefix cannot contain one" do
      assert HostAddresses.reject_in_prefix(["203.0.113.5", "10.0.0.5"], @prefix) ==
               ["203.0.113.5", "10.0.0.5"]
    end

    test "preserves the order of the survivors" do
      assert HostAddresses.reject_in_prefix(
               ["203.0.113.5", "2a03:4000:20:2d3:cafe::5", "2a03:4000:20:2d3::1"],
               @prefix
             ) == ["203.0.113.5", "2a03:4000:20:2d3::1"]
    end

    # THE mode-1 pin. `pool_with_reservations` (the default, and every
    # server that never set a prefix) stores no prefix at all, and its
    # candidate list must come through byte-identical — reading
    # `in_cidr6?/2` and concluding "nil is falsy anyway" is a reading of
    # the code, and a reading gives the structure, never the magnitude.
    test "a nil prefix (mode 1) returns the list IDENTICAL" do
      addresses = ["203.0.113.5", "2a03:4000:20:2d3:cafe::5", "2a03:4000:20:2d3::1"]
      assert HostAddresses.reject_in_prefix(addresses, nil) == addresses
    end

    test "a nil prefix does not even drop an address that a prefix would" do
      assert HostAddresses.reject_in_prefix(["2a03:4000:20:2d3:cafe::5"], nil) ==
               ["2a03:4000:20:2d3:cafe::5"]
    end

    test "a malformed prefix drops nothing (degrade open, not shut)" do
      addresses = ["2a03:4000:20:2d3:cafe::5", "203.0.113.5"]
      assert HostAddresses.reject_in_prefix(addresses, "not-a-cidr") == addresses
    end

    test "an empty universe stays empty" do
      assert HostAddresses.reject_in_prefix([], @prefix) == []
    end
  end
end
