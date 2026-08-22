defmodule Grappa.Session.LinkStateReportTest do
  @moduledoc """
  #1675 — the seam between a dead upstream and the row the UI reads.

  The defect: `network_credentials.connection_state` recorded that a
  session process was STARTED, not that IRC came up, so a network failing
  every connect attempt rendered as `connected` and the operator had no
  way to tell it from a live one. These tests drive the real path —
  `Session.Server` → the plan's injected `link_state_reporter` closure →
  `Networks.report_link_state/3` → the row + the broadcast — against a
  real socket (`Grappa.IRCServer`), never a mocked `:gen_tcp`.

  Both directions are covered here because both were missing: a failed
  connect must WRITE `:failing` + the cause, and 001 RPL_WELCOME must
  take it back to `:connected` with the cause cleared.

  `async: false` — `SessionRegistry`, `SessionSupervisor`, `PubSub` and
  `Session.Backoff` are singletons.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Networks, Scrollback, Session}
  alias Grappa.PubSub.Topic

  describe "a connect that never reaches the upstream" do
    test "marks the row :failing with the real cause, and leaves the session retrying" do
      # A port nothing listens on: the connect is refused deterministically,
      # which is the harness twin of vjt's three prod cases (TLS hostname
      # mismatch / A-only host against a v6 source / connect timeout) — all
      # of them arrive here as the SAME `{:irc_connect_failed, reason}`.
      port = IRCServer.pick_unused_port()
      {user, network, cred} = user_with_credential(port, %{})
      assert cred.connection_state == :connected

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      pid = start_session_for(user, network)

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: :connection_state_changed,
                         from: :connected,
                         to: :failing,
                         reason: reason
                       }
                     },
                     5_000

      # The cause, not a category label. `:econnrefused` is the shape the
      # gen_tcp connect returns; the operator must read WHY, not "error".
      assert is_binary(reason)
      assert reason =~ "refused"

      reloaded = reload_credential(cred)
      assert reloaded.connection_state == :failing
      assert reloaded.connection_state_reason == reason

      # Non-terminal: the session is still up and its backoff ladder is
      # still running. This is the property `mark_failed/2` cannot have.
      assert Process.alive?(pid)

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "puts the cause in the $server window too — not only in the server log" do
      port = IRCServer.pick_unused_port()
      {user, network, _} = user_with_credential(port, %{})

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      pid = start_session_for(user, network)

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :connection_state_changed, to: :failing}
                     },
                     5_000

      rows =
        Scrollback.fetch({:user, user.id}, network.id, "$server", nil, 50, "grappa-test", false)

      assert Enum.any?(rows, fn row ->
               row.kind == :server_event and is_binary(row.body) and row.body =~ "refused"
             end),
             "expected a $server row naming the connect failure, got: " <>
               inspect(Enum.map(rows, & &1.body))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "001 RPL_WELCOME on a row that was failing" do
    test "takes it back to :connected and clears the cause" do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, network, cred} = user_with_credential(port, %{})

      # Seed the state a previous incarnation would have left behind: the
      # row says the link is down, the reboot resumed it (that resume is
      # itself #1675 point 4), and this connect is the one that works.
      :ok =
        Networks.report_link_state(
          {:user, user.id},
          network.id,
          {:failing, "connection refused"}
        )

      assert reload_credential(cred).connection_state == :failing

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      pid = start_session_for(user, network)
      :ok = IRCServer.await_handshake(server, 2_000)
      IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: :connection_state_changed,
                         from: :failing,
                         to: :connected,
                         reason: nil
                       }
                     },
                     5_000

      reloaded = reload_credential(cred)
      assert reloaded.connection_state == :connected
      assert reloaded.connection_state_reason == nil

      assert Session.whereis({:user, user.id}, network.id) == pid

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end
end
