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

  ## The oracle: `join_ref`, and why it is timing-free

  Which PATH delivered a frame is directly observable, and it is the same
  distinction production makes. `Phoenix.ChannelTest.join/4` mints a
  `ref: System.unique_integer/1` for the join message and the framework
  carries it onto `socket.join_ref`, so:

    * a FASTLANE frame is built by `serializer.fastlane!/1` from a
      `%Broadcast{}`, which has no ref — `join_ref: nil`, exactly the
      `[nil, nil, topic, event, payload]` the V2 serializer puts on the wire;
    * a `push/3` frame is built from `%Message{join_ref: socket.join_ref}` —
      a positive integer here, the `[join_ref, nil, …]` shape on the wire.

  That makes "did this socket keep its fastlane?" an assertion on a delivered
  frame rather than on a clock. It matters most for the BUG 6 arm: the
  dispatcher writes the fastlane copy SYNCHRONOUSLY inside
  `broadcast_event/2`, so a duplicate is already AHEAD of the push copy in
  this process's mailbox — asserting on the FIRST matching frame catches it
  with no window to tune. `subscription_metadata/1` is kept as the structural
  companion for the arms that assert about a topic nobody broadcasts on.
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
  alias Grappa.Scrollback.{Message, Wire}
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
    |> Enum.map(fn {_, meta} -> meta end)
  end

  describe "default join (no params) — the compatibility guarantee" do
    test "keeps the framework fastlane subscription untouched" do
      {user, network} = setup_user_and_network()
      chan = "#pp_default"
      topic = Topic.channel(user.name, network.slug, chan)

      {:ok, _, socket} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      settle(socket, :fastlane)

      assert Enum.any?(subscription_metadata(topic), &match?({:fastlane, _, _, _}, &1)),
             "a default join must stay a fastlane subscriber — that is what makes it " <>
               "byte-identical and free for third-party clients"

      # ...and prove it on a real frame, not only in the registry: a fastlane
      # frame carries no join_ref.
      payload = broadcast_row(user, network, chan, %{kind: :privmsg, sender: "peer", body: "oi"})

      assert_receive %Phoenix.Socket.Message{event: "event", payload: ^payload, join_ref: nil}
    end

    test "delivers a peer join, part and quit" do
      {user, network} = setup_user_and_network()
      chan = "#pp_default_kinds"
      topic = Topic.channel(user.name, network.slug, chan)

      {:ok, _, socket} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      settle(socket, :fastlane)

      for kind <- Message.pausable_presence_kinds() do
        payload = broadcast_row(user, network, chan, %{kind: kind, sender: "peer"})
        assert_push("event", ^payload)
      end
    end

    test "an unrecognised presence param value is treated as the default" do
      {user, network} = setup_user_and_network()
      chan = "#pp_garbage"
      topic = Topic.channel(user.name, network.slug, chan)

      {:ok, _, socket} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{"presence" => "nope"})

      settle(socket, :fastlane)

      payload = broadcast_row(user, network, chan, %{kind: :join, sender: "peer"})
      assert_push("event", ^payload)
    end
  end

  describe "join with presence: false" do
    setup do
      {user, network} = setup_user_and_network()
      chan = "#pp_suppressed"
      topic = Topic.channel(user.name, network.slug, chan)

      {:ok, _, socket} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{"presence" => false})

      settle(socket, :plain)

      %{user: user, network: network, chan: chan, topic: topic}
    end

    test "drops every pausable peer presence kind", ctx do
      for kind <- Message.pausable_presence_kinds() do
        refute_delivered(ctx, %{kind: kind, sender: "peer"})
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

    test "arrives once, on the push path — BUG 6 regression", ctx do
      payload =
        broadcast_row(ctx.user, ctx.network, ctx.chan, %{
          kind: :privmsg,
          sender: "peer",
          body: "una sola volta"
        })

      # FIRST matching frame, deliberately: a leftover fastlane subscription
      # would have written its copy synchronously inside `broadcast_event/2`,
      # so it would be ahead of this one and `join_ref` would be nil. No
      # window to tune, and it fails naming the mechanism.
      assert_receive %Phoenix.Socket.Message{event: "event", payload: ^payload, join_ref: join_ref}

      assert is_integer(join_ref),
             "frame arrived with join_ref nil — that is a FASTLANE frame, so this socket " <>
               "still holds the subscription `drop_fastlane_if_suppressing/1` was meant to " <>
               "trade away (BUG 6: one broadcast, two frames)"

      # Zero window for the same reason as `refute_delivered/2`: the duplicate
      # this guards is written by the DISPATCHER, synchronously inside
      # `broadcast_event/2`, so it is in the mailbox before the push copy the
      # assertion above just consumed.
      refute_receive %Phoenix.Socket.Message{event: "event", payload: ^payload}, 0
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
      {user, _} = setup_user_and_network()
      topic = Topic.user(user.name)

      {:ok, _, socket} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{"presence" => false})

      # `:fastlane`, not `:plain` — that IS the assertion. The param is only
      # read for a channel-shaped topic, so the user topic must keep the
      # subscription the framework gave it even though the join asked.
      settle(socket, :fastlane)

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

      {:ok, _, joined_socket} = subscribe_and_join(live_socket, topic, %{"presence" => false})

      # Barrier + drain: the arms below must assert on their own frame, and
      # must not race the fastlane swap.
      settle(joined_socket, :plain)

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
      refute_delivered(ctx, %{kind: :part, sender: "someone-else"})
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

  # Assert a row was DROPPED, with no timing window anywhere.
  #
  # A bare `refute_push(..., 50)` is wrong twice. It is a race (the suppressed
  # path runs dispatcher -> channel mailbox -> `handle_out` -> `push`, so the
  # frame can land after the window), and with a wildcard payload it also
  # catches unrelated live traffic — measured: a session's own `window_state`
  # broadcast tripped it once in 6893 tests.
  #
  # Instead: broadcast the row under test, then a SENTINEL on the same topic.
  # Both travel the same process pair, so Erlang's message ordering makes the
  # sentinel a barrier — once it has arrived, the row under test has either
  # arrived before it or was dropped. `assert_receive` scans the mailbox
  # selectively and leaves non-matching messages in place, so a delivered row
  # is still sitting there for the refute, which can therefore use a ZERO
  # window: the answer is already in the mailbox or it is never coming.
  defp refute_delivered(ctx, attrs) do
    dropped = broadcast_row(ctx.user, ctx.network, ctx.chan, attrs)

    sentinel =
      broadcast_row(ctx.user, ctx.network, ctx.chan, %{
        kind: :privmsg,
        sender: "sentinel",
        body: "barrier-#{System.unique_integer([:positive])}"
      })

    assert_push("event", ^sentinel)
    refute_push("event", ^dropped, 0)
  end

  # The barrier every arm needs, and the two corrections it took to get right
  # — both measured, both worth keeping written down.
  #
  # FIRST TRY, WRONG: `:sys.get_state(socket.channel_pid)` alone. The
  # reasoning was that a synchronous call queues behind the `:after_join`
  # message, so returning proves the after-join leg ran. It does not.
  # `:after_join` arrives via `Process.send_after(self(), …, 0)`, which is a
  # TIMER and not a `send`: the message is enqueued by the timer service and
  # can land AFTER a call made later in wall-clock time. Symptom, on some
  # seeds only — frames arriving with `join_ref: nil`, i.e. FASTLANE frames,
  # on a socket that had asked for suppression.
  #
  # SECOND TRY, AND WHY THIS ONE IS A BARRIER: poll the PubSub registry until
  # this channel pid's subscription metadata has reached the expected shape.
  # That is the exact state every arm depends on, read out of the framework's
  # own bookkeeping rather than inferred from a proxy, so it cannot be early.
  # `:sys.get_state/1` stays afterwards doing the job it IS good for —
  # draining a mid-flight callback so the snapshot pushes are in this
  # process's mailbox before we clear it.
  #
  # `expect` is asserted rather than assumed: a barrier that gave up quietly
  # would leave every arm downstream racing again, which is the failure it
  # exists to remove.
  # ⚠️ THE TWO EXPECTATIONS ARE NOT SYMMETRIC, and pretending they were is what
  # let two mutants live.
  #
  # `:plain` is a state the join must REACH, so polling for it is a genuine
  # barrier: it cannot pass early.
  #
  # `:fastlane` is the state the join STARTS in — `init_join/3` installs it
  # before `join/3` has even returned. Polling for it is satisfied instantly
  # and proves nothing about what `:after_join` did afterwards. Measured:
  # mutants that made the param bite on the user topic (M6: assign it for
  # every topic shape; M7: M6 plus a swap in the user arm) both survived a
  # suite that only polled for `:fastlane`.
  #
  # So the `:fastlane` side pins the DECISION instead of racing the effect.
  # `presence_suppressed` is assigned synchronously inside `join/3`, so
  # reading it out of the channel's state is timing-free and is exactly the
  # fact the non-channel clause exists to establish. Both mutants die on it.
  #
  # Honest residual, since the difference matters: nothing here forbids a swap
  # arriving LATER on a default socket. What forbids it is structural — only
  # the `{:channel, …}` after-join clause calls the swap verb — and this suite
  # does not independently prove that.
  defp settle(socket, expect) when expect in [:fastlane, :plain] do
    if expect == :plain, do: wait_for_subscription(socket, expect, 200)

    state = :sys.get_state(socket.channel_pid)

    assert state.assigns.presence_suppressed == (expect == :plain),
           """
           the join's presence DECISION is wrong for this topic.

             topic:               #{socket.topic}
             presence_suppressed: #{inspect(state.assigns.presence_suppressed)}
             expected:            #{inspect(expect == :plain)}

           Only a channel-shaped topic reads the param — presence never travels
           the user or network topics, so a flag there could only ever cost
           them their fastlane for nothing.
           """

    if expect == :fastlane do
      assert match?({:fastlane, _, _, _}, channel_metadata(socket)),
             "expected this channel to still hold the framework fastlane, got " <>
               inspect(channel_metadata(socket))
    end

    drain_pushes()
    socket
  end

  defp wait_for_subscription(socket, expect, 0) do
    flunk("""
    the channel never reached the #{expect} subscription state.

      topic:   #{socket.topic}
      channel: #{inspect(socket.channel_pid)}
      now:     #{inspect(channel_metadata(socket))}

    `:fastlane` is what the framework installs in `init_join/3`; `:plain` is
    what `drop_fastlane_if_suppressing/1` trades it for in `:after_join`.
    """)
  end

  defp wait_for_subscription(socket, expect, tries) do
    actual =
      case channel_metadata(socket) do
        {:fastlane, _, _, _} -> :fastlane
        nil -> :plain
        _ -> :unknown
      end

    if actual == expect do
      :ok
    else
      Process.sleep(5)
      wait_for_subscription(socket, expect, tries - 1)
    end
  end

  # `:absent` and `nil` are DIFFERENT answers and must not collapse: `nil` IS
  # the metadata of a plain subscription, which is the very state the barrier
  # waits for, while `:absent` means this pid holds no subscription at all.
  # Matching the pid with a filter (rather than `Enum.find_value/2`, which
  # reads a `nil` value as "keep looking") is what keeps them apart.
  defp channel_metadata(socket) do
    Grappa.PubSub
    |> Registry.lookup(socket.topic)
    |> Enum.filter(fn {pid, _} -> pid == socket.channel_pid end)
    |> metadata_of()
  end

  defp metadata_of([{_, meta} | _]), do: meta
  defp metadata_of([]), do: :absent

  defp drain_pushes do
    receive do
      %Phoenix.Socket.Message{} -> drain_pushes()
    after
      0 -> :ok
    end
  end
end
