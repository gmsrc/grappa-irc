defmodule Grappa.Session.RejoinSnapshotTest do
  @moduledoc """
  GH #1385 — `network_credentials.last_joined_channels` is the rejoin
  snapshot: the set a reconnecting session plans its JOINs from
  (`SessionPlan.merge_autojoin/2`). During the restore window that follows
  a reconnect the live keyset (`state.members`) starts EMPTY and grows one
  self-JOIN echo at a time, so any snapshot derived from it is a strict
  PREFIX of the truth until the last echo lands.

  These tests pin the two halves of the production loss measured on
  2026-08-16: the prefix must not be persisted over the complete snapshot,
  and a session that dies mid-restore must still plan the complete set on
  its next boot.

  `async: false` — `Grappa.SessionRegistry` / `SessionSupervisor` /
  `Grappa.PubSub` are singletons.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Session}
  alias Grappa.Networks.{Credentials, SessionPlan}
  alias Grappa.PubSub.Topic

  @snapshot ["#a", "#b", "#c"]

  # A session mid-restore: the credential carries the complete pre-drop
  # snapshot, the three planned JOINs are on the wire, and NOT ONE self-JOIN
  # echo has come back yet. This is the exact state the `Read/Dead Error`
  # wave of 2026-08-16 04:40 interrupted.
  defp restoring_session do
    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "rj-#{System.unique_integer([:positive])}")

    _ = credential_fixture(user, network, %{autojoin_channels: []})
    :ok = Credentials.update_last_joined_channels(user.id, network.id, @snapshot)

    pid = start_session_for(user, network)
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
    IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")

    Enum.each(@snapshot, fn channel ->
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "JOIN " <> channel <> "\r\n"), 1_000)
    end)

    # Pre-state: the row still holds the COMPLETE set at the moment the
    # restore window opens. Anything that shrinks it from here is this
    # window's doing, not the fixture's.
    assert Credentials.get_credential!(user, network).last_joined_channels == @snapshot

    %{server: server, user: user, network: network, pid: pid}
  end

  # The persist runs in the same `handle_info` as the `channels_changed`
  # broadcast, immediately AFTER it. So the broadcast alone is not a write
  # barrier — a `:sys.get_state/1` call, serialized behind that same
  # handle_info, is.
  defp await_first_echo_persisted(server, user, pid) do
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
    IRCServer.feed(server, ":grappa-test!u@h JOIN :#a\r\n")

    assert_receive %Phoenix.Socket.Broadcast{event: "event", payload: %{kind: :channels_changed}},
                   1_000

    _ = :sys.get_state(pid)
    :ok
  end

  test "one restored channel does not overwrite the snapshot with the prefix" do
    %{server: server, user: user, network: network, pid: pid} = restoring_session()

    :ok = await_first_echo_persisted(server, user, pid)

    assert Credentials.get_credential!(user, network).last_joined_channels == @snapshot

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  # The discriminator between sourcing the departures from the EVENT and
  # diffing the keyset. `#c` is in the snapshot and NOT live (its JOIN never
  # came back), so parting it moves no keyset at all: a diff sees nothing
  # removed, writes nothing, and the channel the operator just left survives
  # in the row to be re-JOINed on the next reconnect.
  test "parting a channel we are not live in still drops it from the snapshot" do
    %{server: server, user: user, network: network, pid: pid} = restoring_session()

    :ok = await_first_echo_persisted(server, user, pid)

    :ok = Session.send_part({:user, user.id}, network.id, "#c", nil)

    # The cast persists BEFORE it puts PART on the wire, so the line is the
    # write barrier.
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PART #c\r\n"), 1_000)

    assert Credentials.get_credential!(user, network).last_joined_channels == ~w(#a #b)

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "a session that dies mid-restore still plans the full set on its next boot" do
    %{server: server, user: user, network: network, pid: pid} = restoring_session()

    :ok = await_first_echo_persisted(server, user, pid)

    # The drop. Whatever the snapshot said at this instant is what every
    # subsequent reconnect restores — the permanence half of #1385.
    :ok = GenServer.stop(pid, :normal, 1_000)

    {:ok, plan} = SessionPlan.resolve(Credentials.get_credential!(user, network))
    assert plan.autojoin_channels == @snapshot
  end
end
