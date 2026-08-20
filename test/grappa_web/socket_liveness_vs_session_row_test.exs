defmodule GrappaWeb.SocketLivenessVsSessionRowTest do
  @moduledoc """
  Pins the premise the whole `Grappa.Accounts.Revocations` design rests
  on: **an open WebSocket's liveness is independent of its `sessions`
  row.**

  `Revocations`' moduledoc states it ("`GrappaWeb.UserSocket`
  authenticates once, at connect, and holds no further tie to the row —
  so the teardown has to be pushed"), and #1499 proposed removing the
  reaper's announcement on the opposite reading: that a reaped row can
  never carry a live socket, because `authenticate/1` refuses it. The
  two readings differ on whether an ALREADY-OPEN socket re-authenticates.
  It does not, and nothing here is arguable from the call graph alone —
  hence a test rather than a comment.

  What follows is therefore a characterization gate, not a regression
  guard for a fix: it is the measurement that says which cures for #1499
  are admissible. Should a future change give a live socket any tie back
  to its row (a periodic re-auth, a `last_seen_at` bump from the WS
  path), the first test here goes red and the reasoning above must be
  re-derived before it is edited.
  """
  use GrappaWeb.ChannelCase, async: false

  import Ecto.Query
  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Repo}
  alias Grappa.Accounts.{Reaper, Session}
  alias Grappa.PubSub.Topic
  alias GrappaWeb.{GrappaChannel, UserSocket}

  @idle_seconds 7 * 24 * 3600

  # Seven days of an open socket that spoke only over the WebSocket.
  # `last_seen_at` is bumped by `authenticate/1` alone, and the WS path
  # reaches it exactly once, at connect — so time passing on a live
  # socket looks identical to time passing on an abandoned one.
  defp age_past_idle_window(session_id) do
    when_seen = DateTime.add(DateTime.utc_now(), -(@idle_seconds + 3600), :second)
    query = from(s in Session, where: s.id == ^session_id)
    {1, _} = Repo.update_all(query, set: [last_seen_at: when_seen])
    :ok
  end

  defp connect_socket(token) do
    Phoenix.ChannelTest.connect(UserSocket, %{}, connect_info: %{auth_token: token})
  end

  test "an open socket keeps serving after its own row crosses the idle window" do
    {user, session} = user_and_session()

    assert {:ok, socket} = connect_socket(session.id)

    :ok = age_past_idle_window(session.id)

    # Dead in law: no door would let this bearer in again.
    assert {:error, :expired} = Accounts.authenticate(session.id)

    # Alive in fact: the socket joins and is served with no further
    # contact with the row it was born from.
    assert {:ok, _, chan} = subscribe_and_join(socket, GrappaChannel, Topic.user(user.name))
    assert Process.alive?(chan.channel_pid)
  end

  # The claim is unchanged from when this was written: nothing but the
  # sweep's announcement closes a socket whose row has aged out under it.
  # The ADDRESS changed with #1499 — the reaper now announces the session
  # rather than its owner, so the teardown arrives on the per-session
  # id-topic. Subscribing to the subject topic here would pass vacuously
  # by never seeing anything either way, so the test follows the address.
  test "the reaper's announcement is the only thing that closes that socket" do
    {user, session} = user_and_session()

    assert {:ok, _} = connect_socket(session.id)

    :ok = age_past_idle_window(session.id)

    GrappaWeb.Endpoint.subscribe(UserSocket.id_for_session(session.id))
    GrappaWeb.Endpoint.subscribe(UserSocket.id_for_subject({:user, user}))

    assert {:ok, 1} = Reaper.sweep()

    session_topic = UserSocket.id_for_session(session.id)
    assert_receive %Phoenix.Socket.Broadcast{topic: ^session_topic, event: "disconnect"}, 1_000

    subject_topic = UserSocket.id_for_subject({:user, user})
    refute_receive %Phoenix.Socket.Broadcast{topic: ^subject_topic}, 100
  end
end
