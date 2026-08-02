defmodule GrappaWeb.RequestBudgetTest do
  @moduledoc """
  GH #630 — the shared web adapter over `Grappa.RateLimit.RequestBudget`
  that BOTH inbound doors call. `guard/3` runs the ladder and, on the sever
  crossing, performs the transport sever ONCE (notify → revoke bearer →
  close socket → operator record).

  These tests pin the sever's PARTIAL-FAILURE contract. A flood IS peak DB
  write contention and the ladder severs exactly once, so a transient
  SQLITE_BUSY on the bearer revoke must NOT abort the teardown: the subject
  is still notified, the socket is still closed, and `guard/3` still returns
  `{:error, :severed}` without crashing the caller. Pre-fix the revoke was a
  bare `:ok = Accounts.revoke_session(...)` (an unwrapped `update_all`) that
  MatchError-crashed under busy — skipping the socket close and, because the
  ladder severs only once, permanently defeating enforcement for the window.
  """
  use GrappaWeb.ChannelCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Accounts
  alias Grappa.PubSub.Topic
  alias Grappa.RateLimit.RequestBudget
  alias GrappaWeb.RequestBudget, as: Guard

  # Tiny deterministic thresholds for THIS test only (global test config
  # leaves the budget effectively off); refill 0.5/s so no token refills
  # mid-burst. Restore on exit so metering can't leak into sibling tests.
  setup do
    original = RequestBudget.config()

    RequestBudget.put_test_config(%RequestBudget{
      capacity: 2,
      refill_per_sec: 0.5,
      sever_after: 2,
      sever_window_ms: 60_000
    })

    on_exit(fn -> RequestBudget.put_test_config(original) end)

    user = user_fixture()
    {:ok, session} = Accounts.create_session({:user, user.id}, nil, nil, [])

    # Watch the subject's user topic (the sever notification) and the
    # id-topic the socket disconnect broadcasts on.
    GrappaWeb.Endpoint.subscribe(Topic.user(user.name))
    GrappaWeb.Endpoint.subscribe("user_socket:#{user.name}")

    %{subject: {:user, user.id}, session: session, user_name: user.name}
  end

  # Drive the ladder to the frame JUST before the sever crossing: capacity
  # tokens (all :ok) + (sever_after - 1) over-budget events (:rate_limited).
  # The caller's NEXT guard/3 call is the crossing.
  defp drive_to_brink(subject, session_id, user_name) do
    for _ <- 1..2, do: assert(:ok = Guard.guard(subject, session_id, user_name))
    assert {:error, :rate_limited} = Guard.guard(subject, session_id, user_name)
  end

  test "sever crossing on a healthy DB: subject notified + bearer revoked + socket closed", ctx do
    %{subject: subject, session: session, user_name: user_name} = ctx
    drive_to_brink(subject, session.id, user_name)

    assert {:error, :severed} = Guard.guard(subject, session.id, user_name)

    assert_receive %Phoenix.Socket.Broadcast{
      event: "event",
      payload: %{kind: :web_session_severed, code: :rate_limit_flood}
    }

    assert {:error, :revoked} = Accounts.authenticate(session.id)
    assert_receive %Phoenix.Socket.Broadcast{event: "disconnect"}
  end

  test "a sustained-busy bearer revoke does not abort the sever: socket still closed, subject still notified",
       ctx do
    %{subject: subject, session: session, user_name: user_name} = ctx
    drive_to_brink(subject, session.id, user_name)

    # Force the bearer revoke to degrade to :db_unavailable for its whole
    # retry budget. The revoke runs inside guard/3 in THIS process, so the
    # per-process fault seam lands squarely on it.
    Grappa.Repo.BusyRetry.inject_transient_faults(10_000)

    assert {:error, :severed} = Guard.guard(subject, session.id, user_name)

    # 1. The subject is still told (the broadcast runs before the revoke).
    assert_receive %Phoenix.Socket.Broadcast{
      event: "event",
      payload: %{kind: :web_session_severed, code: :rate_limit_flood}
    }

    # 2. The socket is STILL closed — the teardown continued past the
    #    degraded revoke instead of crashing the guard.
    assert_receive %Phoenix.Socket.Broadcast{event: "disconnect"}

    # 3. Documented degradation: under sustained saturation the revoke did
    #    not land, so the bearer survives — but the live socket is gone and
    #    the stale bearer is throttled on its next request.
    assert {:ok, _} = Accounts.authenticate(session.id)
  end
end
