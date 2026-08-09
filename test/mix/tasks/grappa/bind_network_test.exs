defmodule Mix.Tasks.Grappa.BindNetworkTest do
  @moduledoc """
  Smoke-tests `mix grappa.bind_network` end-to-end: creates user (via
  Accounts), runs the task, asserts the network + server + credential
  rows exist with the right shape.
  """
  # async: false — setup writes user + network + server + credential per
  # test, which collide with sibling mix-task tests under sqlite's
  # single-writer model.
  use Grappa.DataCase, async: false

  import ExUnit.CaptureIO

  alias Grappa.{Accounts, Networks}
  alias Grappa.Networks.{Credentials, Servers}
  alias Mix.Tasks.Grappa.BindNetwork

  setup do
    {:ok, user} = Accounts.create_user(%{name: "vjt", password: "correct horse battery staple"})
    %{user: user}
  end

  test "binds a user to a new network with one server", %{user: user} do
    output =
      capture_io(fn ->
        BindNetwork.run([
          "--user",
          "vjt",
          "--network",
          "azzurra",
          "--server",
          "irc.azzurra.chat:6697",
          "--tls",
          "--nick",
          "vjt-grappa",
          "--password",
          "secret",
          "--auth",
          "auto",
          "--autojoin",
          "#grappa,#italy"
        ])
      end)

    assert output =~ "bound vjt to azzurra"

    assert {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})
    assert [server] = Servers.list_servers(network)
    assert server.host == "irc.azzurra.chat"
    assert server.port == 6697
    assert server.tls == true

    cred = Credentials.get_credential!(user, network)
    assert cred.nick == "vjt-grappa"
    assert cred.auth_method == :auto
    assert cred.autojoin_channels == ["#grappa", "#italy"]
    assert cred.password_encrypted == "secret"
  end

  test "port-sniff default: :6667 server defaults to tls: false", %{user: _user} do
    capture_io(fn ->
      BindNetwork.run([
        "--user",
        "vjt",
        "--network",
        "azzurra",
        "--server",
        "irc.azzurra.chat:6667",
        "--nick",
        "vjt-grappa",
        "--auth",
        "none"
      ])
    end)

    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})
    [server] = Servers.list_servers(network)
    assert server.tls == false
  end

  test "port-sniff default: :6697 server defaults to tls: true", %{user: _user} do
    capture_io(fn ->
      BindNetwork.run([
        "--user",
        "vjt",
        "--network",
        "azzurra",
        "--server",
        "irc.azzurra.chat:6697",
        "--nick",
        "vjt-grappa",
        "--auth",
        "none"
      ])
    end)

    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})
    [server] = Servers.list_servers(network)
    assert server.tls == true
  end

  test "is idempotent on the server (re-add same host:port is no-op)", %{user: _user} do
    args = [
      "--user",
      "vjt",
      "--network",
      "azzurra",
      "--server",
      "irc.azzurra.chat:6697",
      "--tls",
      "--nick",
      "vjt-grappa",
      "--auth",
      "none"
    ]

    capture_io(fn -> BindNetwork.run(args) end)

    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})
    [_] = Servers.list_servers(network)

    # Second run with a fresh user but same server should succeed
    # without raising on the server-uniqueness conflict.
    {:ok, _} = Accounts.create_user(%{name: "alice", password: "correct horse battery staple"})

    args2 = ["--user", "alice" | tl(args)]
    capture_io(fn -> BindNetwork.run(args2) end)

    [_] = Servers.list_servers(network)
  end

  test "auth=none accepts no password", %{user: _user} do
    output =
      capture_io(fn ->
        BindNetwork.run([
          "--user",
          "vjt",
          "--network",
          "azzurra",
          "--server",
          "irc.azzurra.chat:6697",
          "--nick",
          "vjt-grappa",
          "--auth",
          "none"
        ])
      end)

    assert output =~ "bound vjt to azzurra"
  end

  test "halts when --user names an unknown user" do
    assert_raise Ecto.NoResultsError, fn ->
      capture_io(fn ->
        BindNetwork.run([
          "--user",
          "nope",
          "--network",
          "azzurra",
          "--server",
          "h:6697",
          "--nick",
          "n",
          "--auth",
          "none"
        ])
      end)
    end
  end

  test "raises Mix.Error on a malformed --server" do
    assert_raise Mix.Error, fn ->
      capture_io(fn ->
        BindNetwork.run([
          "--user",
          "vjt",
          "--network",
          "azzurra",
          "--server",
          "no-port-here",
          "--nick",
          "n",
          "--auth",
          "none"
        ])
      end)
    end
  end

  test "raises Mix.Error on an unknown --auth" do
    assert_raise Mix.Error, fn ->
      capture_io(fn ->
        BindNetwork.run([
          "--user",
          "vjt",
          "--network",
          "azzurra",
          "--server",
          "h:6697",
          "--nick",
          "n",
          "--auth",
          "garbage"
        ])
      end)
    end
  end

  # #1086 — this used to assert `KeyError`, pinning the very defect the
  # issue reports: `Keyword.fetch!` on an option the strict parse had
  # already discarded dumped a raw Elixir traceback at an operator. The
  # test encoded the bug, which is why the bug survived.
  test "a missing required option names it, without a traceback" do
    error =
      assert_raise Mix.Error, fn ->
        BindNetwork.run(["--network", "azzurra", "--server", "h:6697", "--nick", "n"])
      end

    assert error.message =~ "--user"
    assert error.message =~ "--auth"
  end

  # The typo case from the issue. Reporting the unknown switch takes
  # precedence over the required option it failed to set: telling the
  # operator "--network is missing" would send them hunting for a flag
  # they did type.
  test "an unknown switch is reported, naming it, rather than discarded" do
    error =
      assert_raise Mix.Error, fn ->
        BindNetwork.run([
          "--user",
          "vjt",
          "--nework",
          "azzurra",
          "--server",
          "h:6697",
          "--nick",
          "n",
          "--auth",
          "none"
        ])
      end

    assert error.message =~ "--nework"
    refute error.message =~ "missing required"
  end

  test "a known switch with an unparseable value names the switch and the value" do
    error =
      assert_raise Mix.Error, fn ->
        BindNetwork.run([
          "--user",
          "vjt",
          "--network",
          "azzurra",
          "--server",
          "h:6697",
          "--nick",
          "n",
          "--auth",
          "none",
          "--tls=maybe"
        ])
      end

    assert error.message =~ "--tls"
    assert error.message =~ "maybe"
  end

  test "--services-flavor sets the network's services flavor on create", %{user: _user} do
    capture_io(fn ->
      BindNetwork.run([
        "--user",
        "vjt",
        "--network",
        "libera",
        "--services-flavor",
        "atheme",
        "--server",
        "irc.libera.chat:6697",
        "--nick",
        "vjt-grappa",
        "--auth",
        "none"
      ])
    end)

    {:ok, network} = Networks.find_or_create_network(%{slug: "libera"})
    assert network.services_flavor == :atheme
  end

  test "no --services-flavor leaves the network unclassified (nil)", %{user: _user} do
    capture_io(fn ->
      BindNetwork.run([
        "--user",
        "vjt",
        "--network",
        "azzurra",
        "--server",
        "irc.azzurra.chat:6697",
        "--nick",
        "vjt-grappa",
        "--auth",
        "none"
      ])
    end)

    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})
    assert network.services_flavor == nil
  end

  test "--source persists the server source_address", %{user: _user} do
    capture_io(fn ->
      BindNetwork.run([
        "--user",
        "vjt",
        "--network",
        "azzurra",
        "--server",
        "irc.azzurra.chat:6697",
        "--nick",
        "vjt-grappa",
        "--auth",
        "none",
        "--source",
        "203.0.113.9"
      ])
    end)

    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})
    [server] = Servers.list_servers(network)
    assert server.source_address == "203.0.113.9"
  end
end
