defmodule GrappaWeb.GrappaChannelPresenceParamsTest do
  @moduledoc """
  #1769 — the server half of #1680's presence pause: a socket that joins a
  per-channel topic with `%{"presence" => false}` stops being sent PEER
  join/part/quit frames, and everything else on that topic is delivered
  byte-for-byte as before.

  The tests are written against the two guarantees the shape was chosen for,
  not against the mechanism:

    * **Default is everything.** A join that does not ask keeps the
      framework fastlane (asserted structurally off the PubSub registry
      metadata — the only place "this socket is still a fastlane subscriber"
      is observable) and keeps receiving every kind.
    * **Suppression drops only what the client can afford to miss.** The
      drop set is `Message.pausable_presence_kinds/0` — a strict subset of
      the presence kinds — and NEVER our own presence, mirroring cic's
      `PAUSABLE_PRESENCE_KINDS` (`presencePause.ts`) and its carve-outs:
      `nick_change` drives the #372/#373 identity migration, `mode` feeds
      channel-mode state, and an own PART tears the window down.

  ⚠️ `socket.join_ref` is nil in `Phoenix.ChannelTest` (nothing sets it), so
  the production wire difference between a fastlane frame (`[nil, nil, …]`)
  and a `push/3` frame (`[join_ref, nil, …]`) is NOT observable here — an
  assertion on `join_ref` would be vacuously green on both arms. The registry
  metadata is the oracle that is not.
  """
  use GrappaWeb.ChannelCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.IRCServer

  alias Grappa.{
    AdmissionStateHelpers,
    Networks,
    Repo,
    ScrollbackHelpers,
    Session
  }

  alias Grappa.Networks.{Credentials, Servers}
  alias Grappa.PubSub.Topic
  alias Grappa.Scrollback.Message
  alias Grappa.Scrollback.Wire
  alias GrappaWeb.UserSocket

  setup do
    AdmissionStateHelpers.reset_all()
    :ok
  end

  defp build_socket(user_name) do
    socket(UserSocket, "user_socket:#{user_name}", %{
      user_name: user_name,
      current_subject: {:user, Ecto.UUID.generate()},
      current_session_id: Ecto.UUID.generate(),
      socket_ref: Ecto.UUID.generate()
    })
  end

  # A user + network with NO live session: enough for every peer-presence
  # arm, since the own-nick carve-out only ever ADDS deliveries.
  defp setup_user_and_network do
    user_name = "pp-#{System.unique_integer([:positive])}"
    user = user_fixture(name: user_name)

    {:ok, network} =
      Networks.find_or_create_network(%{slug: "pp-net-#{System.unique_integer([:positive])}"})

    {user, network}
  end

  # Persists a row through the production changeset and renders it with the
  # production broadcast formatter, so the payload under test is the one
  # `Session.Persistor` publishes — never a hand-built map.
  defp broadcast_row(user, network, chan, attrs) do
    {:ok, message} =
      ScrollbackHelpers.insert(
        Map.merge(
          %{
            user_id: user.id,
            network_id: network.id,
            channel: chan,
            server_time: System.unique_integer([:positive, :monotonic]) + 1_700_000_000_000,
            body: nil
          },
          attrs
        )
      )

    payload = Wire.message_payload(message, network.slug)
    :ok = Grappa.PubSub.broadcast_event(Topic.channel(user.name, network.slug, chan), payload)
    payload
  end

  # The one place "this socket still holds the framework fastlane" is
  # observable: `Phoenix.Channel.Server.init_join/3` subscribes with
  # `metadata: {:fastlane, transport_pid, serializer, intercepts}`, and the
  # PubSub registry IS `Grappa.PubSub`.
  defp subscription_metadata(topic) do
    Grappa.PubSub
    |> Registry.lookup(topic)
    |> Enum.map(fn {_pid, meta} -> meta end)
  end

  describe "default join (no params) — the compatibility guarantee" do
    test "keeps the framework fastlane subscription untouched" do
      {user, network} = setup_user_and_network()
      chan = "#pp_default"
      topic = Topic.channel(user.name, network.slug, chan)

      {:ok, _, _} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert Enum.any?(subscription_metadata(topic), &match?({:fastlane, _, _, _}, &1)),
             "a default join must stay a fastlane subscriber — that is what makes it " <>
               "byte-identical and free for third-party clients"
    end

    test "delivers a peer join, part and quit" do
      {user, network} = setup_user_and_network()
      chan = "#pp_default_kinds"
      topic = Topic.channel(user.name, network.slug, chan)

      {:ok, _, _} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      for kind <- Message.pausable_presence_kinds() do
        payload = broadcast_row(user, network, chan, %{kind: kind, sender: "peer"})
        assert_push("event", ^payload)
      end
    end

    test "an unrecognised presence param value is treated as the default" do
      {user, network} = setup_user_and_network()
      chan = "#pp_garbage"
      topic = Topic.channel(user.name, network.slug, chan)

      {:ok, _, _} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{"presence" => "nope"})

      payload = broadcast_row(user, network, chan, %{kind: :join, sender: "peer"})
      assert_push("event", ^payload)
    end
  end

  describe "join with presence: false" do
    setup do
      {user, network} = setup_user_and_network()
      chan = "#pp_suppressed"
      topic = Topic.channel(user.name, network.slug, chan)

      {:ok, _, _} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{"presence" => false})

      %{user: user, network: network, chan: chan, topic: topic}
    end

    test "drops every pausable peer presence kind", ctx do
      for kind <- Message.pausable_presence_kinds() do
        broadcast_row(ctx.user, ctx.network, ctx.chan, %{kind: kind, sender: "peer"})
        refute_push("event", _, 50)
      end
    end

    test "still delivers a peer message — messages must not be lost", ctx do
      payload =
        broadcast_row(ctx.user, ctx.network, ctx.chan, %{
          kind: :privmsg,
          sender: "peer",
          body: "ciao raga"
        })

      assert_push("event", ^payload)
    end

    test "delivers the message EXACTLY once — BUG 6 regression", ctx do
      payload =
        broadcast_row(ctx.user, ctx.network, ctx.chan, %{
          kind: :privmsg,
          sender: "peer",
          body: "una sola volta"
        })

      assert_push("event", ^payload)
      refute_push("event", ^payload, 50)
    end

    test "still delivers the non-pausable presence kinds (nick_change, mode)", ctx do
      carved_out = Message.suppressed_presence_kinds() -- Message.pausable_presence_kinds()
      assert carved_out != [], "the carve-out set must not be empty or this test is vacuous"

      for kind <- carved_out do
        meta = if kind == :nick_change, do: %{new_nick: "peer2"}, else: %{}

        payload =
          broadcast_row(ctx.user, ctx.network, ctx.chan, %{
            kind: kind,
            sender: "peer",
            meta: meta
          })

        assert_push("event", ^payload)
      end
    end

    test "still delivers a non-message event (window_counts)", ctx do
      payload = %{kind: :window_counts, channel: ctx.chan, counts: %{messages: 1}}
      :ok = Grappa.PubSub.broadcast_event(ctx.topic, payload)

      assert_push("event", ^payload)
    end
  end

  describe "presence: false on a topic that is not channel-shaped" do
    test "is ignored on the user topic — its traffic is unaffected" do
      {user, _network} = setup_user_and_network()
      topic = Topic.user(user.name)

      {:ok, _, _} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{"presence" => false})

      assert Enum.any?(subscription_metadata(topic), &match?({:fastlane, _, _, _}, &1)),
             "presence never travels the user topic, so the param must not cost it its fastlane"
    end
  end

  describe "own presence is never dropped" do
    setup do
      {irc_server, port} = IRCServer.start_server(IRCServer.passthrough_handler())

      user_name = "pp-own-#{System.unique_integer([:positive])}"
      user = user_fixture(name: user_name)
      slug = "pp-own-net-#{System.unique_integer([:positive])}"
      {:ok, network} = Networks.find_or_create_network(%{slug: slug})
      {:ok, _} = Servers.add_server(network, %{host: "127.0.0.1", port: port, tls: false})

      {:ok, credential} =
        Credentials.bind_credential(user, network, %{
          nick: "grappa-snap",
          auth_method: :none,
          autojoin_channels: ["#pp_own"]
        })

      {:ok, plan} = Networks.SessionPlan.resolve(Repo.preload(credential, :network))
      {:ok, _} = Session.start_session({:user, user.id}, network.id, plan)
      on_exit(fn -> Session.stop_session({:user, user.id}, network.id) end)

      :ok = IRCServer.await_handshake(irc_server, 1_000)
      IRCServer.feed(irc_server, ":irc.test.org 001 grappa-snap :Welcome\r\n")

      {:ok, _} =
        IRCServer.wait_for_line(irc_server, &String.starts_with?(&1, "JOIN #pp_own"), 1_000)

      IRCServer.feed(irc_server, ":grappa-snap!u@h JOIN :#pp_own\r\n")

      chan = "#pp_own"
      topic = Topic.channel(user.name, network.slug, chan)

      live_socket =
        socket(UserSocket, "user_socket:#{user.name}", %{
          user_name: user.name,
          current_subject: {:user, user.id},
          current_session_id: Ecto.UUID.generate(),
          socket_ref: Ecto.UUID.generate()
        })

      {:ok, _, _} = subscribe_and_join(live_socket, topic, %{"presence" => false})

      # Drain the cold-subscribe snapshots so the arms below assert on their
      # own frame and not on a leftover.
      drain_pushes()

      %{user: user, network: network, chan: chan, topic: topic, irc_server: irc_server}
    end

    test "delivers our OWN part — dropping it would strand a dead window", ctx do
      payload = broadcast_row(ctx.user, ctx.network, ctx.chan, %{kind: :part, sender: "grappa-snap"})
      assert_push("event", ^payload)
    end

    test "own-nick match folds ASCII (#121/#537), so casing does not leak a drop", ctx do
      payload = broadcast_row(ctx.user, ctx.network, ctx.chan, %{kind: :part, sender: "GRAPPA-Snap"})
      assert_push("event", ^payload)
    end

    test "still drops a peer part on the same socket — the carve-out is not a bypass", ctx do
      broadcast_row(ctx.user, ctx.network, ctx.chan, %{kind: :part, sender: "someone-else"})
      refute_push("event", _, 50)
    end

    test "the own-nick cache follows an own nick_change", ctx do
      # The rename itself is carved out of the drop set, so the socket sees it
      # — and that is the only signal the channel process gets. A part by the
      # NEW nick must still be delivered afterwards.
      rename =
        broadcast_row(ctx.user, ctx.network, ctx.chan, %{
          kind: :nick_change,
          sender: "grappa-snap",
          meta: %{new_nick: "grappa-snap2"}
        })

      assert_push("event", ^rename)

      payload =
        broadcast_row(ctx.user, ctx.network, ctx.chan, %{kind: :part, sender: "grappa-snap2"})

      assert_push("event", ^payload)
    end
  end

  defp drain_pushes do
    receive do
      %Phoenix.Socket.Message{} -> drain_pushes()
    after
      100 -> :ok
    end
  end
end
