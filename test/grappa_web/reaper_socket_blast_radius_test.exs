defmodule GrappaWeb.ReaperSocketBlastRadiusTest do
  @moduledoc """
  #1499 — the BLAST RADIUS of the idle-session reaper, measured on live
  transports rather than on the announcement.

  `Grappa.SessionRevocationTest` asserts that the reaper announces, and
  `GrappaWeb.SessionRevocationListenerTest` asserts that an announcement
  reaches an id-topic. Neither can see the defect, because both are
  written from the point of view of ONE subject: the reaper's
  announcement is keyed by `{:user, name}`, so a test that expects a
  teardown for that user gets one and is satisfied. The question #1499
  asks is how many OTHER sockets went down with it, and that is only
  visible with two live transports of the same user in the same test.

  Reaping is the door where this matters most: it fires on a 60s timer
  with no request and no operator behind it, so the socket it takes down
  belongs to whoever happened to be connected.

  ## Why a transport process per socket

  Both halves of the mechanism under test are per-PROCESS. The id-topic
  subscription is made by `Phoenix.Socket.__init__/1` in the process that
  connects, and the teardown is that same process receiving a
  `"disconnect"` broadcast. Two sockets assembled in the test process
  would share one mailbox and one subscription set — exactly the
  distinction the measurement needs.

  `start_transport!/1` is therefore a stand-in for the WebSock adapter,
  NOT for the socket: it drives the production `Phoenix.Socket.Transport`
  callbacks `GrappaWeb.UserSocket` generates (`connect/1`, `init/1`,
  `handle_info/2`) and holds no opinion of its own about what should
  close a connection. `init/1` establishes the real subscription set;
  `handle_info/2` is what turns a `"disconnect"` broadcast into
  `{:stop, …}`. The loop only obeys the verdict it is handed, so a
  passing test here cannot be an artefact of the harness agreeing with
  itself.
  """
  use GrappaWeb.ChannelCase, async: false

  import Ecto.Query
  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Repo}
  alias Grappa.Accounts.{Reaper, Session}
  alias GrappaWeb.UserSocket

  @idle_seconds 7 * 24 * 3600

  describe "the idle-session reaper" do
    test "reaping one session leaves the same user's other socket serving" do
      user = user_fixture()
      stale = session_fixture(user)
      fresh = session_fixture(user)

      # Both sockets connect while both bearers are still good — the
      # ageing comes after, because `authenticate/1` refuses an expired
      # row at the door and bumps `last_seen_at` when it admits one.
      # This is the order the incident had: a bridge that connected days
      # before an unrelated row of the same account crossed the window.
      stale_ws = start_transport!(stale.id)
      fresh_ws = start_transport!(fresh.id)

      stale_ref = Process.monitor(stale_ws)
      fresh_ref = Process.monitor(fresh_ws)

      :ok = age_past_idle_window(stale.id)

      # The pre-state, so a socket that never came up cannot be mistaken
      # for one the sweep took down.
      assert Process.alive?(stale_ws)
      assert Process.alive?(fresh_ws)

      # Exactly one row is reaped. Asserted, not assumed: a sweep that
      # found nothing would satisfy every survival claim below while
      # measuring nothing at all.
      assert {:ok, 1} = Reaper.sweep()

      # Positive control — the reaped session's own socket DOES go down.
      # Without it, the survival assertion could pass on a teardown path
      # that had simply stopped working.
      assert_receive {:DOWN, ^stale_ref, :process, ^stale_ws, _}, 1_000

      # The defect. Both transports subscribe to the SUBJECT id-topic, so
      # the per-user announcement closes this one too, though its bearer
      # is untouched and its row was never a reap candidate.
      refute_receive {:DOWN, ^fresh_ref, :process, ^fresh_ws, _}, 200
      assert Process.alive?(fresh_ws)

      # …and it was never dead in law either, which is what makes the
      # teardown a defect rather than a rounding error.
      assert {:ok, _} = Accounts.authenticate(fresh.id)
    end

    # The counterweight. Narrowing the reaper must not narrow the doors
    # whose whole job is to take the account off every device it is on:
    # `revoke_sessions_for_user/1` is operator recovery, and a survivor
    # there is a security failure, not a blip.
    test "an account-wide revoke still takes down every socket of the user" do
      user = user_fixture()
      one = session_fixture(user)
      two = session_fixture(user)

      one_ws = start_transport!(one.id)
      two_ws = start_transport!(two.id)

      one_ref = Process.monitor(one_ws)
      two_ref = Process.monitor(two_ws)

      assert :ok = Accounts.revoke_sessions_for_user(user)

      assert_receive {:DOWN, ^one_ref, :process, ^one_ws, _}, 1_000
      assert_receive {:DOWN, ^two_ref, :process, ^two_ws, _}, 1_000
    end
  end

  # Seven days and an hour of silence on the row, leaving the socket
  # untouched. `last_seen_at` is bumped by `Accounts.authenticate/1`
  # alone, which the WS path reaches once, at connect — so this is not a
  # contrived state, it is what any WS-only client's row does on its own.
  @spec age_past_idle_window(Ecto.UUID.t()) :: :ok
  defp age_past_idle_window(session_id) do
    when_seen = DateTime.add(DateTime.utc_now(), -(@idle_seconds + 3600), :second)
    query = from(s in Session, where: s.id == ^session_id)
    {1, _} = Repo.update_all(query, set: [last_seen_at: when_seen])
    :ok
  end

  # Brings up one transport process per socket and returns its pid, or
  # fails the test naming what `UserSocket` did instead. The connect map
  # mirrors the one `Phoenix.ChannelTest.__connect__/4` builds — that
  # helper discards the transport state, and the state is what
  # `handle_info/2` needs.
  @spec start_transport!(String.t()) :: pid()
  defp start_transport!(token) do
    parent = self()

    connect_map = %{
      endpoint: GrappaWeb.Endpoint,
      transport: :websocket,
      options: [serializer: [{Phoenix.ChannelTest.NoopSerializer, "~> 1.0.0"}]],
      params: %{},
      connect_info: %{auth_token: token}
    }

    pid =
      spawn(fn ->
        case UserSocket.connect(connect_map) do
          {:ok, state} ->
            {:ok, state} = UserSocket.init(state)
            send(parent, {:transport_up, self()})
            serve(state)

          refused ->
            send(parent, {:transport_refused, self(), refused})
        end
      end)

    # Registered before the wait: a transport that comes up and is never
    # torn down would outlive the sandbox owner and keep speaking to a
    # checked-in connection. `on_exit` runs LIFO, so this fires before
    # `ChannelCase`'s `stop_owner`.
    on_exit(fn -> Process.exit(pid, :kill) end)

    receive do
      {:transport_up, ^pid} -> pid
      {:transport_refused, ^pid, refused} -> flunk("UserSocket refused the bearer: #{inspect(refused)}")
    after
      1_000 -> flunk("transport process never reported in")
    end
  end

  # The adapter's loop, with the adapter's opinions left out: every
  # message is handed to the production `handle_info/2` and the return
  # value decides. `{:stop, …}` ends the process, which is what
  # `Process.alive?/1` and the monitor above read as "the socket closed".
  @spec serve(term()) :: :ok
  defp serve(state) do
    receive do
      message ->
        case UserSocket.handle_info(message, state) do
          {:ok, state} -> serve(state)
          {:push, _, state} -> serve(state)
          {:stop, _, _, _} -> :ok
          {:stop, _, _} -> :ok
        end
    end
  end
end
