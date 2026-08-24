defmodule Grappa.Session.PersistStallLivenessTest do
  @moduledoc """
  #1759 — reproduction harness for *"a saturated SQLite pool is laundered into
  a false liveness verdict"*.

  ## Framed as a REPRODUCTION, deliberately

  The issue asks for a stress test asserting that **no session is declared
  dead**. Written that way it is a green that cannot fail: the liveness
  watchdog does not live in `Grappa.Session.Server` at all, so a test that
  saturates the persist path and then asserts survival passes on an unrelated
  invariant and pins nothing.

  So the question these tests ask is the opposite one: **can the death be
  produced?** A negative answer is the result — it is an executable, ongoing
  confirmation that the causal chain the issue describes does not exist in
  this code. To keep that negative honest, every survival assertion here is
  paired with evidence that the harness *constructed the condition* (the
  probe fired, the target really was parked) and with a positive control
  proving the same harness DOES observe a `:ping_timeout` when one occurs.

  ## The topology under test

  `Grappa.IRC.Client` is a **separate GenServer** from `Session.Server`. It
  owns the socket, resets the liveness cycle before parsing (`arm_idle/1` at
  the inbound choke point), dispatches upward with an asynchronous `send/2`,
  and drains an already-fired timer from its own mailbox. A parked
  `Session.Server` mailbox is therefore not on the path to the verdict.

  ## The geometry, which is what the harness must build

  A session can only die if its `:liveness_idle` probe fires and the full
  `liveness_timeout_ms` then elapses with no inbound byte. Measured against
  the incident window: a ~64 s stall opens a ~34 s window in which a probe
  must fire, and only a socket already silent for a full 60 s enters it —
  which is why the two prod deaths were 2 of 45 and not 45 of 45. **A harness
  that only drives a burst never builds that condition and tests nothing.**
  Every arm below either forces the probe to fire or asserts it did.

  ## Scale

  `Grappa.IRC.Client` accepts `:liveness_idle_ms` / `:liveness_timeout_ms` as
  `start_link/1` opts (its #100 test seam), so the client-layer arms run the
  full cycle in milliseconds.

  ⚠️ `Session.Server.client_opts/1` does **not** thread those opts, so a
  session-layer client always runs the 60 s / 30 s config defaults — 90 s to
  a verdict, inert inside any test. That is why the causal question is asked
  at the client layer and the session layer is used for what it can answer:
  that a genuinely parked `Session.Server` survives a saturated persist path
  and degrades. Closing that gap is a production change and is out of scope
  here (Phase B is suspended).
  """

  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures

  alias Grappa.IRC.Client
  alias Grappa.IRCServer
  alias Grappa.Repo.BusyRetry

  # Scaled liveness cycle: 350ms to a verdict instead of 90s. Chosen so the
  # ~1.5s persist stall reproduced below (see @stall_faults) spans more than
  # four complete idle+timeout cycles — the parked window must comfortably
  # contain the verdict, or a survival assertion proves only that the test
  # was too short.
  @idle_ms 150
  @timeout_ms 200

  # `BusyRetry.loop/4` sleeps `min(25 * attempt, 200)` between attempts and
  # gives up once elapsed reaches its 1_500ms budget: 25+50+75+100+125+150+
  # 175+200+200+200+200 ≈ 1_500. So each stalled persist parks its session
  # for ~1.5s of GENUINE in-callback blocking — the real thing, not
  # `:sys.suspend/1`, so the process is parked the way production parks it.
  #
  # The count is deliberately far above the ~11 checks that budget affords:
  # what bounds the stall is the BUDGET, not the count, and a count that runs
  # out mid-loop lets the op finally succeed — no degradation, no terminal
  # line, and a silently weaker test. Same 10_000 the #594 channel and
  # passkey seams use, for the same reason.
  @stall_faults 10_000

  # A channel the session never joined. The inbound persist arm does not gate
  # on join state (the #336 precedent in `server_test.exs` drives it exactly
  # this way), and a channel target avoids depending on the fixture's nick —
  # which is not ours to assume.
  @burst_channel "#sniffo"

  # A fake ircd that answers our self-PING, i.e. a demonstrably LIVE upstream.
  # Every arm that asserts survival needs this: if the peer were silent the
  # client would be right to declare death and the test would prove nothing.
  defp pong_handler do
    fn state, line ->
      if String.starts_with?(line, "PING") do
        {:reply, ":server PONG grappa-test :grappa-liveness\r\n", state}
      else
        {:reply, nil, state}
      end
    end
  end

  defp start_client(port, dispatch_to) do
    {:ok, client} =
      Client.start_link(%{
        host: "127.0.0.1",
        port: port,
        tls: false,
        dispatch_to: dispatch_to,
        logger_metadata: [],
        nick: "grappa-test",
        ident: "grappa-test",
        realname: "grappa-test",
        sasl_user: "grappa-test",
        auth_method: :none,
        liveness_idle_ms: @idle_ms,
        liveness_timeout_ms: @timeout_ms
      })

    client
  end

  # A dispatch target that accepts messages and NEVER drains them — the exact
  # state #1759 blames ("the session process is not draining its mailbox").
  # Spawned unlinked-but-owned so a parked mailbox cannot outlive the test.
  defp start_parked_target do
    parked = spawn(fn -> Process.sleep(:infinity) end)
    on_exit(fn -> Process.exit(parked, :kill) end)
    parked
  end

  defp mailbox_len(pid) do
    {:message_queue_len, n} = Process.info(pid, :message_queue_len)
    n
  end

  defp pings_seen(server) do
    Enum.count(IRCServer.sent_lines(server), &String.starts_with?(&1, "PING"))
  end

  # Same shape `server_test.exs` builds privately: a user, a network pointed
  # at the fake ircd's port, and the credential the plan resolves from.
  defp user_and_network(port) do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")

    _ = credential_fixture(user, network, %{})
    {user, network}
  end

  describe "#1759 arm 1 — can a parked dispatch target produce the verdict?" do
    test "a dispatch target that never drains does NOT trip :ping_timeout" do
      # This is the issue's mechanism, reproduced as literally as the code
      # permits: the process the Client dispatches to is wedged and its
      # mailbox only grows. If the verdict were a function of that process's
      # liveness, this is where it would fire.
      {server, port} = IRCServer.start_server(pong_handler())
      Process.flag(:trap_exit, true)

      parked = start_parked_target()
      client = start_client(port, parked)

      # Geometry, precondition 1: the probe must actually fire. Without an
      # observed PING the socket was never silent long enough and the arm
      # would be asserting survival over a window the watchdog never entered.
      assert {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "PING"), 1_000)

      # Feed inbound traffic the wedged target can never consume, so its
      # mailbox is provably backed up for the whole window.
      Enum.each(1..40, fn i ->
        IRCServer.feed(server, ":a!~a@h PRIVMSG #busy :burst #{i}\r\n")
      end)

      # Span several complete idle+timeout cycles.
      Process.sleep(4 * (@idle_ms + @timeout_ms))

      # Geometry, precondition 2: the target really was parked. A drained
      # mailbox would mean the condition under test never held and the
      # survival below is vacuous.
      assert mailbox_len(parked) > 0,
             "the dispatch target must be provably backed up, else this arm tests nothing"

      assert Process.alive?(client),
             "a parked dispatch target must not be able to kill the socket owner"

      refute_received {:EXIT, ^client, :ping_timeout}

      # And the cycle kept turning throughout — the client was not merely
      # idle, it was actively probing and being answered while the target
      # stayed wedged.
      assert pings_seen(server) >= 2,
             "expected the probe to keep firing across the parked window, saw #{pings_seen(server)}"
    end
  end

  describe "#1759 arm 2 — positive control" do
    test "the same harness DOES observe :ping_timeout when the socket truly goes silent" do
      # Without this arm, arm 1 is unfalsifiable: a survival assertion that
      # could never fail is not evidence. Same client, same timings, same
      # parked dispatch target — the ONLY change is that the peer stops
      # answering. The verdict must fire.
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      Process.flag(:trap_exit, true)

      parked = start_parked_target()
      client = start_client(port, parked)

      assert {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "PING"), 1_000)

      assert_receive {:EXIT, ^client, :ping_timeout}, 1_000
    end

    test "an answered probe and an unanswered probe differ ONLY in the peer's reply" do
      # Pins the discriminator itself: the verdict tracks inbound bytes on the
      # socket and nothing else. Both halves run with a wedged dispatch target,
      # so the parked-mailbox variable is held constant across the pair and
      # the peer's PONG is the single degree of freedom left.
      Process.flag(:trap_exit, true)

      {_, live_port} = IRCServer.start_server(pong_handler())
      live = start_client(live_port, start_parked_target())

      {_, dead_port} = IRCServer.start_server(IRCServer.passthrough_handler())
      dead = start_client(dead_port, start_parked_target())

      assert_receive {:EXIT, ^dead, :ping_timeout}, 1_000
      assert Process.alive?(live)
      refute_received {:EXIT, ^live, :ping_timeout}
    end
  end

  describe "#1759 arm 3 — N sessions under a saturated persist path (vjt's ask)" do
    test "every session survives a saturated persist burst and degrades to :persist_unavailable" do
      # The half of the issue that DOES hold: the five synchronous
      # `Persistor.persist_and_broadcast/3` call sites block the session's own
      # mailbox for the duration of the stall. This arm reproduces that with
      # real `Session.Server` processes and a real ~1.5s in-callback stall per
      # session, and pins #336's guarantee — the damage is a dropped row, not
      # a dead session.
      #
      # It does NOT and CANNOT test the liveness verdict: a session-layer
      # client runs the un-injectable 60s/30s defaults (see @moduledoc). What
      # it establishes is that the parking is real and survivable.
      sessions =
        for _ <- 1..3 do
          {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
          {user, network} = user_and_network(port)
          pid = start_session_for(user, network)
          :ok = IRCServer.await_handshake(server, 1_000)
          {server, pid}
        end

      for {_, pid} <- sessions do
        BusyRetry.arm_faults(pid, @stall_faults, fire_on: 1)
        on_exit(fn -> BusyRetry.disarm_faults(pid) end)
      end

      # Drive the inbound persist path on every session at once — the burst
      # the issue describes, arriving while every persist is stalling. DMs to
      # our own nick, not a channel: they persist unconditionally, without
      # depending on join state the harness would otherwise have to build.
      log =
        capture_log(fn ->
          for {server, _} <- sessions, i <- 1..2 do
            IRCServer.feed(server, ":a!~a@h PRIVMSG #{@burst_channel} :saturating burst #{i}\r\n")
          end

          # Two stalled persists per session, each burning the full ~1.5s
          # budget serially on that session's own mailbox.
          Process.sleep(3_500)
        end)

      for {_, pid} <- sessions do
        assert Process.alive?(pid),
               "a saturated persist path must degrade the row, never kill the session (#336)"
      end

      # Evidence the stall was REAL and happened inside the session, not that
      # the burst quietly bypassed the persist path: `BusyRetry` only emits
      # its terminal line after burning the whole budget. The phrase is the
      # stable one the #1429 census and its bats pins already anchor on
      # verbatim, so asserting it here tracks the same contract.
      assert log =~ "db write unavailable",
             "expected a real budget-exhausting stall inside the session processes"

      for {_, pid} <- sessions do
        :ok = GenServer.stop(pid, :normal, 1_000)
      end
    end
  end

  # No arm asserts `Scrollback.with_pool_retry/1`'s tagged-tuple contract
  # directly: `Grappa.ScrollbackTest` already pins it from both raising
  # topologies ("an op that always raises DBConnection.ConnectionError /
  # a busy Exqlite.Error degrades to {:error, :persist_unavailable} — does
  # NOT escape"). Restating it here would be a second copy of one contract,
  # free to drift. What is NOT covered there, and is covered above, is the
  # same stall reaching N live sessions at once.
end
