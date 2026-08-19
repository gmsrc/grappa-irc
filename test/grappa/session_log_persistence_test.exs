defmodule Grappa.SessionLogPersistenceTest do
  @moduledoc """
  #215 HALF 2 — the `Grappa.SessionLog` GenServer sink: telemetry →
  disk (`session_log_events`) → bounded prune → PubSub broadcast, plus the
  `list/1` tail read the REST + channel doors consume.

  `async: false` — `Grappa.SessionLog` is a singleton registered as
  `__MODULE__` (max_cases: 1 invariant). The sink boots with
  `attach_telemetry: false` in test env, so this suite attaches the
  handler itself.

  It does NOT need a `Sandbox.allow/3` for the sink, and used to carry
  one that did nothing: `Grappa.DataCase` opens every `async: false`
  suite with `start_owner!(Repo, shared: not tags[:async])`, and SHARED
  mode already routes every ownerless process in the VM — the sink
  included — onto this test's connection. Measured by deleting the
  `allow` and re-running: green, and the suite's own seven tests are the
  positive control, since each one reads back rows the sink wrote.

  The door is therefore the ATTACH, not the allow: while the handler is
  attached, any session-lifecycle event fired anywhere in the VM writes
  a row into whichever test is running. See #1551.
  """
  use Grappa.DataCase, async: false

  alias Grappa.PubSub.Topic
  alias Grappa.{Repo, SessionLog}
  alias Grappa.SessionLog.Event

  @handler_id "session-log-persist-test"
  @events [
    [:grappa, :session, :log, :connected],
    [:grappa, :session, :log, :registered],
    [:grappa, :session, :log, :identified],
    [:grappa, :session, :log, :deidentified],
    [:grappa, :session, :log, :disconnected],
    [:grappa, :session, :log, :backoff]
  ]

  setup do
    Repo.delete_all(Event)

    :ok =
      :telemetry.attach_many(@handler_id, @events, &SessionLog.handle_telemetry/4, nil)

    on_exit(fn -> :telemetry.detach(@handler_id) end)
    :ok
  end

  defp state(subject), do: %{subject: subject, network_id: 7, network_slug: "az", nick: "vjt"}

  # Barrier: the telemetry handler casts to the sink; a following call
  # (get_state) is processed AFTER the cast, so the persist has landed.
  defp drain, do: :sys.get_state(SessionLog)

  test "emit persists a row queryable via list/1 with all structured fields" do
    SessionLog.emit(:disconnected, state({:user, "u1"}),
      reason: ":tcp_closed",
      clean: false,
      duration_ms: 42
    )

    drain()

    assert [%Event{} = row] = SessionLog.list(10)
    assert row.event == :disconnected
    assert row.session_id == "user:u1:7"
    assert row.subject_kind == :user
    assert row.network_id == 7
    assert row.network_slug == "az"
    assert row.nick == "vjt"
    assert row.reason == ":tcp_closed"
    assert row.clean == false
    assert row.duration_ms == 42
    assert %DateTime{} = row.at
  end

  test "list/1 returns newest-first and honours the limit" do
    for n <- 1..5, do: SessionLog.emit(:connected, state({:user, "u#{n}"}), [])
    drain()

    rows = SessionLog.list(3)
    assert length(rows) == 3
    # Newest-first: u5, u4, u3 (insertion order 1..5).
    assert Enum.map(rows, & &1.session_id) == ["user:u5:7", "user:u4:7", "user:u3:7"]
  end

  test "prune keeps only the newest `retention` rows on disk" do
    prev = :sys.get_state(SessionLog).retention
    on_exit(fn -> :sys.replace_state(SessionLog, fn s -> %{s | retention: prev} end) end)
    :sys.replace_state(SessionLog, fn s -> %{s | retention: 3} end)

    for n <- 1..6, do: SessionLog.emit(:connected, state({:user, "u#{n}"}), [])
    drain()

    assert Repo.aggregate(Event, :count) == 3
    assert Enum.map(SessionLog.list(10), & &1.session_id) == ["user:u6:7", "user:u5:7", "user:u4:7"]
  end

  describe "list_latest_per_session/1 (#1158 item 4)" do
    test "collapses a session's history to its newest event" do
      SessionLog.emit(:connected, state({:visitor, "v1"}), [])

      SessionLog.emit(:disconnected, state({:visitor, "v1"}),
        reason: ":quit",
        clean: true,
        duration_ms: 900
      )

      drain()

      assert [%Event{} = row] = SessionLog.list_latest_per_session(10)
      assert row.session_id == "visitor:v1:7"
      assert row.event == :disconnected
      assert row.reason == ":quit"
      assert row.duration_ms == 900
    end

    test "returns one row per session, newest-first" do
      for n <- 1..3, do: SessionLog.emit(:connected, state({:user, "u#{n}"}), [])
      SessionLog.emit(:disconnected, state({:user, "u1"}), reason: ":tcp_closed", clean: false)
      drain()

      rows = SessionLog.list_latest_per_session(10)

      assert Enum.map(rows, & &1.session_id) == ["user:u1:7", "user:u3:7", "user:u2:7"]
      assert Enum.map(rows, & &1.event) == [:disconnected, :connected, :connected]
    end

    test "the limit bounds SESSIONS, not the raw rows behind them" do
      for n <- 1..3 do
        SessionLog.emit(:connected, state({:user, "u#{n}"}), [])
        SessionLog.emit(:identified, state({:user, "u#{n}"}), [])
      end

      drain()

      # Six rows on disk, three sessions. A row-bounded query would answer
      # ONE session here — the newest two rows both belong to u3.
      assert Repo.aggregate(Event, :count) == 6

      assert Enum.map(SessionLog.list_latest_per_session(2), & &1.session_id) ==
               ["user:u3:7", "user:u2:7"]
    end
  end

  test "persist broadcasts the wire event on Topic.session_log/0" do
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.session_log())

    SessionLog.emit(:connected, state({:visitor, "v1"}), [])

    assert_receive %Phoenix.Socket.Broadcast{
                     topic: "grappa:session_log",
                     event: "event",
                     payload: %{kind: :session_log_event, entry: entry}
                   },
                   1_000

    assert entry.session_id == "visitor:v1:7"
    assert entry.event == :connected
    assert is_integer(entry.id)
  end
end
