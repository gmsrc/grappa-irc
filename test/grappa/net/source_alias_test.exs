defmodule Grappa.Net.SourceAliasTest do
  @moduledoc """
  #543 INC-5 — platform source-alias adapters. The FreeBSD/Linux adapters
  shell through the `Grappa.Sys.HardenedCmd` seam, Mox'd here so the exact
  argv + exit-mapping are asserted without a real `sudo ifconfig` / `sysctl` /
  `ip route`. `Grappa.Net.SourceAlias.Config.cmd/0` resolves to
  `Grappa.Sys.HardenedCmdMock` via config/test.exs.
  """
  use ExUnit.Case, async: false

  import Mox

  alias Grappa.Net.SourceAlias.{Config, Disabled, FreeBSD, Linux}

  setup :verify_on_exit!

  @prefix "2a03:4000:20:2d3:cb::/80"
  @in_prefix "2a03:4000:20:2d3:cb::1"
  @outside "2a03:4000:20:2d3:ffff::1"
  # arm_check derives its probe canary from the prefix — the network base.
  @canary "2a03:4000:20:2d3:cb::"

  describe "Config" do
    test "substrate selects the adapter; put_test_config round-trips" do
      Config.put_test_config(%Config{
        substrate: :jail,
        adapter: FreeBSD,
        cmd: Grappa.Sys.HardenedCmdMock
      })

      assert Config.adapter() == FreeBSD
      assert Config.substrate() == :jail
      assert Config.cmd() == Grappa.Sys.HardenedCmdMock
    end
  end

  describe "FreeBSD.ensure_source/2" do
    test "runs sudo grappa-source-alias add <addr> for an in-prefix address" do
      expect(Grappa.Sys.HardenedCmdMock, :run, fn "sudo", ["grappa-source-alias", "add", addr], t ->
        assert addr == @in_prefix
        assert is_integer(t) and t > 0
        {:ok, ""}
      end)

      assert :ok = FreeBSD.ensure_source(@in_prefix, @prefix)
    end

    test "refuses an address outside the prefix WITHOUT shelling" do
      # No expect/0 on the cmd mock — a shell-out here would fail verify.
      assert {:error, :outside_prefix} = FreeBSD.ensure_source(@outside, @prefix)
    end

    test "propagates a non-zero wrapper exit as an error" do
      expect(Grappa.Sys.HardenedCmdMock, :run, fn "sudo", ["grappa-source-alias", "add", _], _ ->
        {:error, {:exit, 1, "not permitted"}}
      end)

      assert {:error, {:exit, 1, "not permitted"}} = FreeBSD.ensure_source(@in_prefix, @prefix)
    end
  end

  describe "FreeBSD.release_source/2" do
    test "runs sudo grappa-source-alias del <addr>" do
      expect(Grappa.Sys.HardenedCmdMock, :run, fn "sudo", ["grappa-source-alias", "del", addr], _ ->
        assert addr == @in_prefix
        {:ok, ""}
      end)

      assert :ok = FreeBSD.release_source(@in_prefix, @prefix)
    end

    test "refuses an address outside the prefix" do
      assert {:error, :outside_prefix} = FreeBSD.release_source(@outside, @prefix)
    end
  end

  describe "FreeBSD.arm_check/1" do
    test "probes real aliasing capability via `probe <canary>` derived from the prefix" do
      expect(Grappa.Sys.HardenedCmdMock, :run, fn "sudo", ["-n", "grappa-source-alias", "probe", canary], t ->
        assert canary == @canary
        assert is_integer(t) and t > 0
        {:ok, ""}
      end)

      assert :ok = FreeBSD.arm_check(@prefix)
    end

    test "maps exit 69 (substrate refused the alias) to :alias_not_permitted" do
      expect(Grappa.Sys.HardenedCmdMock, :run, fn "sudo", ["-n", "grappa-source-alias", "probe", _], _ ->
        {:error, {:exit, 69, "substrate refused alias — non-VNET jail?"}}
      end)

      assert {:error, :alias_not_permitted} = FreeBSD.arm_check(@prefix)
    end

    test "maps exit 65 (canary outside the wrapper prefix) to :prefix_mismatch" do
      expect(Grappa.Sys.HardenedCmdMock, :run, fn "sudo", ["-n", "grappa-source-alias", "probe", _], _ ->
        {:error, {:exit, 65, "not inside"}}
      end)

      assert {:error, :prefix_mismatch} = FreeBSD.arm_check(@prefix)
    end

    test "maps exit 66 (prefix config unavailable) to :prefix_config_unavailable" do
      expect(Grappa.Sys.HardenedCmdMock, :run, fn "sudo", ["-n", "grappa-source-alias", "probe", _], _ ->
        {:error, {:exit, 66, "prefix config unavailable"}}
      end)

      assert {:error, :prefix_config_unavailable} = FreeBSD.arm_check(@prefix)
    end

    test "refuses to arm when the wrapper/sudoers grant is missing (sudo exit 1)" do
      expect(Grappa.Sys.HardenedCmdMock, :run, fn "sudo", ["-n", "grappa-source-alias", "probe", _], _ ->
        {:error, {:exit, 1, "sudo: a password is required"}}
      end)

      assert {:error, :wrapper_unavailable} = FreeBSD.arm_check(@prefix)
    end

    test "maps a probe timeout to :probe_timeout" do
      expect(Grappa.Sys.HardenedCmdMock, :run, fn "sudo", ["-n", "grappa-source-alias", "probe", _], _ ->
        {:error, :timeout}
      end)

      assert {:error, :probe_timeout} = FreeBSD.arm_check(@prefix)
    end

    test "maps a missing runner binary to :wrapper_unavailable" do
      expect(Grappa.Sys.HardenedCmdMock, :run, fn "sudo", ["-n", "grappa-source-alias", "probe", _], _ ->
        {:error, {:exe_not_found, "sudo"}}
      end)

      assert {:error, :wrapper_unavailable} = FreeBSD.arm_check(@prefix)
    end

    test "rejects an invalid prefix without probing" do
      assert {:error, :invalid_prefix} = FreeBSD.arm_check("nope/80")
    end
  end

  describe "FreeBSD.list_aliases/1" do
    test "returns the inet6 addresses on lo0 inside the prefix" do
      output = """
      lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> metric 0 mtu 16384
      \tinet 127.0.0.1 netmask 0xff000000
      \tinet6 ::1 prefixlen 128
      \tinet6 fe80::1%lo0 prefixlen 64 scopeid 0x2
      \tinet6 2a03:4000:20:2d3:cb::1 prefixlen 128
      \tinet6 2a03:4000:20:2d3:cb::dead prefixlen 128
      """

      expect(Grappa.Sys.HardenedCmdMock, :run, fn "ifconfig", ["lo0"], _ -> {:ok, output} end)

      assert {:ok, aliases} = FreeBSD.list_aliases(@prefix)
      assert Enum.sort(aliases) == ["2a03:4000:20:2d3:cb::1", "2a03:4000:20:2d3:cb::dead"]
    end

    test "canonicalizes each address so reconcile diffs it against canonical held keys" do
      # ifconfig may print a non-canonical spelling (uppercase, expanded
      # zeroes). list_aliases MUST return the `:inet.ntoa` canonical form the
      # manager's held keys carry, or reconcile would mis-classify a live alias
      # as an orphan and release it.
      output = "lo0: flags=8049\n\tinet6 2A03:4000:0020:02D3:00CB:0:0:5 prefixlen 128\n"

      expect(Grappa.Sys.HardenedCmdMock, :run, fn "ifconfig", ["lo0"], _ -> {:ok, output} end)

      assert {:ok, ["2a03:4000:20:2d3:cb::5"]} = FreeBSD.list_aliases(@prefix)
    end

    # #627 — a nil prefix means mode 2 is unconfigured: there is no block to
    # list aliases inside, so the answer is empty WITHOUT touching `ifconfig`.
    # Before the fix this shelled out and filtered `::1` through
    # `in_cidr6?(_, nil)`, raising and crashing the boot reconcile. No cmd
    # `expect` here — a shell-out would fail `verify_on_exit!`.
    test "returns an empty list for a nil prefix WITHOUT shelling (#627)" do
      assert {:ok, []} = FreeBSD.list_aliases(nil)
    end
  end

  describe "Linux (AnyIP no-op adapter)" do
    test "ensure/release are no-ops for an in-prefix address" do
      assert :ok = Linux.ensure_source(@in_prefix, @prefix)
      assert :ok = Linux.release_source(@in_prefix, @prefix)
    end

    test "still refuses an out-of-prefix address" do
      assert {:error, :outside_prefix} = Linux.ensure_source(@outside, @prefix)
    end

    test "list_aliases is empty — AnyIP has no per-address alias to reconcile" do
      assert {:ok, []} = Linux.list_aliases(@prefix)
    end

    # #627 — the reconcile-safety contract holds for a nil prefix too (mode 2
    # unconfigured): AnyIP already makes this a no-op for any argument.
    test "list_aliases is empty for a nil prefix too (#627)" do
      assert {:ok, []} = Linux.list_aliases(nil)
    end

    test "arm_check passes when nonlocal_bind=1 and the AnyIP route is present" do
      expect(Grappa.Sys.HardenedCmdMock, :run, 2, fn
        "sysctl", ["-n", "net.ipv6.ip_nonlocal_bind"], _ ->
          {:ok, "1\n"}

        "ip", ["-6", "route", "show", "table", "local"], _ ->
          {:ok, "local 2a03:4000:20:2d3:cb::/80 dev lo proto kernel metric 0 pref medium\n"}
      end)

      assert :ok = Linux.arm_check(@prefix)
    end

    test "refuses to arm when ip_nonlocal_bind is disabled" do
      expect(Grappa.Sys.HardenedCmdMock, :run, fn "sysctl", ["-n", "net.ipv6.ip_nonlocal_bind"], _ ->
        {:ok, "0\n"}
      end)

      assert {:error, :ip_nonlocal_bind_disabled} = Linux.arm_check(@prefix)
    end

    test "refuses to arm when the AnyIP route is absent" do
      expect(Grappa.Sys.HardenedCmdMock, :run, 2, fn
        "sysctl", ["-n", "net.ipv6.ip_nonlocal_bind"], _ -> {:ok, "1\n"}
        "ip", ["-6", "route", "show", "table", "local"], _ -> {:ok, "local ::1 dev lo\n"}
      end)

      assert {:error, :anyip_route_missing} = Linux.arm_check(@prefix)
    end

    test "rejects an invalid prefix without probing" do
      assert {:error, :invalid_prefix} = Linux.arm_check("nope/80")
    end
  end

  describe "Disabled adapter" do
    test "arm_check returns the concrete missing-prereq reason" do
      assert {:error, :substrate_disabled} = Disabled.arm_check(@prefix)
    end

    test "ensure/release RAISE — never reached while disarmed" do
      assert_raise RuntimeError, ~r/must never be called/, fn ->
        Disabled.ensure_source(@in_prefix, @prefix)
      end

      assert_raise RuntimeError, ~r/must never be called/, fn ->
        Disabled.release_source(@in_prefix, @prefix)
      end
    end

    test "list_aliases is empty — reconcile no-op" do
      assert {:ok, []} = Disabled.list_aliases(@prefix)
    end
  end
end
