defmodule Grappa.Release.LiveNodeTest do
  @moduledoc """
  #1685 — the one hop `grappa add-network` makes out of its own transient
  VM and into the running bouncer.

  ## What is being pinned, and what deliberately is not

  The release wrapper rewrites the account verbs into `eval`, which starts
  a node of its own; a session spawned there dies with the command. The
  cure crosses to the live node over Erlang distribution and makes a
  FUNCTION CALL, so the operator's words travel as terms and nothing they
  type is ever evaluated as source on the production BEAM.

  The two halves are tested differently, because only one of them can be
  run here:

    * `adopt_here/2` — the LIVE half. Under ExUnit the app IS running, so
      this file is a live node: the test drives it for real against
      `Grappa.IRCServer` and asserts a `Session.Server` exists afterwards.
    * `adopt/2` — the CALLING half. Its `:net_kernel.start/2` would make
      the TEST VM distributed and leak into every other test, so only the
      branches that refuse BEFORE any I/O are exercised here. The rest was
      measured on three real substrates (issue #1685, 2026-08-23): 2–3 ms
      to raise distribution, 1–3 ms to connect, and both no-live-node
      shapes failing in under 10 ms.

  `target_node/2` is public and pinned because it encodes a MEASURED
  constraint that reads like a detail and is not: under
  `RELEASE_DISTRIBUTION=name` the host must come from our own node name,
  never from `:inet.gethostname()`. On the measurement bench the two
  disagreed (`box2.example.com` vs `box2`) and the gethostname spelling
  was rejected outright — `** Hostname box2 is illegal **`.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{AdmissionStateHelpers, IRCServer, Networks, Session}
  alias Grappa.Networks.Credentials
  alias Grappa.Release.LiveNode

  setup do
    AdmissionStateHelpers.reset_all()

    on_exit(fn ->
      System.delete_env("RELEASE_NODE")
      System.delete_env("RELEASE_DISTRIBUTION")
    end)

    :ok
  end

  describe "target_node/2 — spelling the live node" do
    test "takes the host from our own node name, not from the OS hostname" do
      assert LiveNode.target_node("grappa", :"grappa_cli_1@box2.example.com") ==
               :"grappa@box2.example.com"

      assert LiveNode.target_node("grappa", :grappa_cli_1@box) == :grappa@box
    end

    test "an operator-qualified RELEASE_NODE is used verbatim" do
      assert LiveNode.target_node("grappa@elsewhere.internal", :grappa_cli_1@box) ==
               :"grappa@elsewhere.internal"
    end
  end

  describe "adopt/2 — refusing before any I/O" do
    test "says so when RELEASE_NODE is absent, because there is no target to name" do
      System.delete_env("RELEASE_NODE")

      assert LiveNode.adopt(Ecto.UUID.generate(), 1) == {:error, :no_release_node}
    end

    test "honours RELEASE_DISTRIBUTION=none instead of trying anyway" do
      System.put_env("RELEASE_NODE", "grappa")
      System.put_env("RELEASE_DISTRIBUTION", "none")

      assert LiveNode.adopt(Ecto.UUID.generate(), 1) == {:error, :distribution_disabled}
    end
  end

  describe "adopt_here/2 — the half that runs in the live node" do
    test "starts a real session for the bound credential" do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {network, _} = network_with_server(port: port, slug: "adopt-#{uniq()}")
      user = user_fixture(name: "adopt-#{uniq()}")
      stop_session_on_exit(user, network)

      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: [],
          connection_state: :parked
        })

      refute Session.whereis({:user, user.id}, network.id)

      assert LiveNode.adopt_here(user.id, network.id) == {:ok, :started}

      assert {:ok, "NICK vjt\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "NICK"), 5_000)

      assert is_pid(Session.whereis({:user, user.id}, network.id))
    end

    test "returns a SMALL term — no credential, and therefore no decrypted secret" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {network, _} = network_with_server(port: port, slug: "adopt-terse-#{uniq()}")
      user = user_fixture(name: "adopt-terse-#{uniq()}")
      stop_session_on_exit(user, network)

      # The one field that would leak: Cloak hands back the CLEARTEXT on
      # load, so returning the struct would put this string on the
      # distribution socket. The contract is that it cannot.
      secret = "loadbearing-#{uniq()}"

      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :nickserv_identify,
          password: secret,
          autojoin_channels: [],
          connection_state: :parked
        })

      result = LiveNode.adopt_here(user.id, network.id)

      assert result == {:ok, :started}
      refute inspect(result, limit: :infinity) =~ secret
    end

    test "names an unknown binding rather than crashing the operator's shell" do
      assert LiveNode.adopt_here(Ecto.UUID.generate(), 987_654) == {:error, :not_found}
    end

    test "reports a refused spawn instead of claiming a session" do
      # A network with no ENABLED server: `SessionPlan.resolve/1` cannot
      # pick one, so the canonical verb refuses — the same
      # `:resolve_failed` the #1163 console door surfaces.
      {:ok, network} = Networks.find_or_create_network(%{slug: "adopt-noserver-#{uniq()}"})
      user = user_fixture(name: "adopt-noserver-#{uniq()}")

      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: [],
          connection_state: :parked
        })

      assert LiveNode.adopt_here(user.id, network.id) == {:error, {:refused, :resolve_failed}}
      refute Session.whereis({:user, user.id}, network.id)
    end
  end

  defp uniq, do: System.unique_integer([:positive])

  defp stop_session_on_exit(user, network) do
    on_exit(fn -> Session.stop_session({:user, user.id}, network.id, "test teardown") end)
  end
end
