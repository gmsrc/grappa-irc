defmodule Grappa.Net.IpLiteralTest do
  @moduledoc """
  #228 — shared strict IP-literal canonicalization. Extracted from the
  `Grappa.Networks.Server` changeset so the new `Grappa.Vhosts.Vhost`
  changeset validates source addresses through the SAME rule (CLAUDE.md
  "implement once, reuse everywhere") instead of copy-pasting the
  strict-parse + `:inet.ntoa/1` canonicalization.
  """
  use ExUnit.Case, async: true

  alias Grappa.Net.IpLiteral

  describe "canonicalize/1" do
    test "accepts a strict IPv4 literal and returns it canonical" do
      assert {:ok, "192.0.2.1"} = IpLiteral.canonicalize("192.0.2.1")
    end

    test "accepts a strict IPv6 literal and rewrites it to canonical compressed form" do
      # Uppercase + non-compressed → lowercase compressed via :inet.ntoa/1.
      assert {:ok, "2001:db8::1"} = IpLiteral.canonicalize("2001:0DB8:0000:0000:0000:0000:0000:0001")
    end

    test "rejects a hostname" do
      assert :error = IpLiteral.canonicalize("irc.example.org")
    end

    test "rejects a CIDR block" do
      assert :error = IpLiteral.canonicalize("2001:db8::/64")
    end

    test "rejects an empty string" do
      assert :error = IpLiteral.canonicalize("")
    end

    test "rejects a zero-padded octet (non-strict)" do
      assert :error = IpLiteral.canonicalize("192.000.002.001")
    end
  end

  describe "family/1" do
    test "returns :inet for a v4 literal" do
      assert :inet = IpLiteral.family("192.0.2.1")
    end

    test "returns :inet6 for a v6 literal" do
      assert :inet6 = IpLiteral.family("2001:db8::1")
    end
  end

  # #252 — the vhost PTR resolver needs the parsed :inet tuple to build the
  # reverse-lookup name; parsing routes through the same strict rule so a
  # non-literal that canonicalize/1 rejects is rejected here identically.
  describe "to_tuple/1" do
    test "parses a strict IPv4 literal to its :inet tuple" do
      assert {:ok, {192, 0, 2, 1}} = IpLiteral.to_tuple("192.0.2.1")
    end

    test "parses a strict IPv6 literal to its :inet6 tuple" do
      assert {:ok, {0x2001, 0x0DB8, 0, 0, 0, 0, 0, 1}} = IpLiteral.to_tuple("2001:db8::1")
    end

    test "rejects a hostname" do
      assert :error = IpLiteral.to_tuple("irc.example.org")
    end

    test "rejects a zero-padded octet (non-strict)" do
      assert :error = IpLiteral.to_tuple("192.000.002.001")
    end
  end

  # #543 — the static-mapping addressing mode configures a derived-source
  # prefix as an IPv6 CIDR. `parse_cidr6/1` yields the {network_tuple, len}
  # the derivation + prefix-impact scan need; `canonicalize_cidr6/1` masks
  # the host bits and renders the network canonical for stable storage.
  describe "parse_cidr6/1" do
    test "parses a strict IPv6 CIDR to {tuple, prefix_len}" do
      assert {:ok, {{0x2A03, 0x4000, 0x20, 0x2D3, 0xCB, 0, 0, 0}, 80}} =
               IpLiteral.parse_cidr6("2a03:4000:20:2d3:cb::/80")
    end

    test "parses a full /128" do
      assert {:ok, {{0x2001, 0x0DB8, 0, 0, 0, 0, 0, 1}, 128}} =
               IpLiteral.parse_cidr6("2001:db8::1/128")
    end

    test "rejects an IPv4 CIDR" do
      assert :error = IpLiteral.parse_cidr6("192.0.2.0/24")
    end

    test "rejects a bare literal with no prefix length" do
      assert :error = IpLiteral.parse_cidr6("2001:db8::1")
    end

    test "rejects a prefix length above 128" do
      assert :error = IpLiteral.parse_cidr6("2001:db8::/129")
    end

    test "rejects a non-strict / malformed address part" do
      assert :error = IpLiteral.parse_cidr6("2001:db8:::/64")
    end

    test "rejects an empty string" do
      assert :error = IpLiteral.parse_cidr6("")
    end
  end

  describe "canonicalize_cidr6/1" do
    test "lowercases + compresses the network and keeps the length" do
      assert {:ok, "2a03:4000:20:2d3:cb::/80"} =
               IpLiteral.canonicalize_cidr6("2A03:4000:20:2D3:00CB:0:0:0/80")
    end

    test "masks host bits below the prefix length to zero" do
      # An operator who pastes an address with host bits set gets the
      # NETWORK back — a prefix is its network, not a host in it.
      assert {:ok, "2a03:4000:20:2d3:cb::/80"} =
               IpLiteral.canonicalize_cidr6("2a03:4000:20:2d3:cb::5/80")
    end

    test "rejects an IPv4 CIDR and a non-literal" do
      assert :error = IpLiteral.canonicalize_cidr6("192.0.2.0/24")
      assert :error = IpLiteral.canonicalize_cidr6("nope/64")
    end
  end

  describe "in_cidr6?/2" do
    test "true when the v6 address sits inside the prefix" do
      assert IpLiteral.in_cidr6?("2a03:4000:20:2d3:cb::1", "2a03:4000:20:2d3:cb::/80")
      assert IpLiteral.in_cidr6?("2a03:4000:20:2d3:cb:dead:beef:1", "2a03:4000:20:2d3:cb::/80")
    end

    test "false when the v6 address is outside the prefix" do
      refute IpLiteral.in_cidr6?("2a03:4000:20:2d3:ffff::1", "2a03:4000:20:2d3:cb::/80")
    end

    test "false for an IPv4 address, a malformed literal, or a malformed prefix" do
      refute IpLiteral.in_cidr6?("192.0.2.1", "2a03:4000:20:2d3:cb::/80")
      refute IpLiteral.in_cidr6?("not-an-ip", "2a03:4000:20:2d3:cb::/80")
      refute IpLiteral.in_cidr6?("2a03:4000:20:2d3:cb::1", "nope/80")
      refute IpLiteral.in_cidr6?("2a03:4000:20:2d3:cb::1", "2a03:4000:20:2d3:cb::/999")
    end

    test "len 128 matches only the exact address; len 0 matches every v6" do
      assert IpLiteral.in_cidr6?("2a03::1", "2a03::1/128")
      refute IpLiteral.in_cidr6?("2a03::2", "2a03::1/128")
      assert IpLiteral.in_cidr6?("2a03:4000:20:2d3:cb::1", "::/0")
    end
  end
end
