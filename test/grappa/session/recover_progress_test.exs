defmodule Grappa.Session.RecoverProgressTest do
  @moduledoc """
  #1390 slice 4 — the FSM-transition → modal-step projection, driven without
  a session.

  Every case here walks the REAL `RecoverIdentity` FSM from `:idle` with
  `step/2` and asks the projection what the modal should be told. Nothing is
  hand-built: a state the FSM cannot produce is not a state worth asserting,
  and driving it this way makes each assertion also a proof that the
  transition is reachable.

  Before this slice the projection was two `defp` clauses inside
  `Session.Server`, so the only way to exercise it was to boot a
  `Session.Server`, a fake ircd and the Repo and read the broadcasts back —
  which is what the 15 tests of `server_test.exs`'s
  `recover_identity (#581) — server integration` describe do, `async: false`,
  for a handful of paths. These run on plain `ExUnit.Case`, `async: true`,
  with no process, no socket and no database.

  Two cases carry the **#1468** defect: a terminal out of
  `:awaiting_verb_settle` or `:awaiting_nick` leaves a step the modal already
  showed as `:running` without a terminal status, so cic renders it spinning
  forever beside a failed outcome. This slice MOVES the projection at parity
  and does not cure it — the two tests below assert what the code does today
  and say so in their names, so the #1468 fix cannot land without turning
  them red.
  """
  use ExUnit.Case, async: true

  alias Grappa.Session.{RecoverIdentity, RecoverProgress}

  defp start_fsm, do: RecoverIdentity.init("vjt", "s3cret")

  # One FSM hop: returns the state reached and what the modal is told about
  # the transition into it.
  defp hop(fsm, input) do
    {_verdict, next, _lines} = RecoverIdentity.step(fsm, input)
    {next, RecoverProgress.steps(fsm.phase, next)}
  end

  defp advance(fsm, inputs), do: Enum.reduce(inputs, fsm, fn i, acc -> elem(hop(acc, i), 0) end)

  describe "the happy path" do
    test "the start transition sets BOTH the nick and the identify step running" do
      # NICK and IDENTIFY go out together, so both steps start together.
      assert {_, [{:nick, :running, nil}, {:identify, :running, nil}]} =
               hop(start_fsm(), :start)
    end

    test "+r observed on the first attempt reports the whole sequence ok" do
      fsm = advance(start_fsm(), [:start])

      assert {_, [{:nick, :ok, nil}, {:identify, :ok, nil}, {:register, :ok, nil}]} =
               hop(fsm, :r_observed)
    end
  end

  describe "the reclaim detour" do
    test "a 433 fails the nick step and starts the RECOVER verb" do
      fsm = advance(start_fsm(), [:start])

      assert {_, [{:nick, :failed, nil}, {:recover, :running, nil}]} =
               hop(fsm, {:nick_error, 433})
    end

    test "a 437 starts the RELEASE verb instead — the verb doubles as its step" do
      fsm = advance(start_fsm(), [:start])

      assert {_, [{:nick, :failed, nil}, {:release, :running, nil}]} =
               hop(fsm, {:nick_error, 437})
    end

    test "the settle tick completes the verb and re-runs the nick step ALONE" do
      # #623 — the identify step deliberately does NOT restart here: it waits
      # for the nick to be observed, so the modal never shows identify running
      # before the nick has landed.
      fsm = advance(start_fsm(), [:start, {:nick_error, 433}])

      assert {_, [{:recover, :ok, nil}, {:nick, :running, nil}]} = hop(fsm, :settle)
    end

    test "the observed re-NICK completes the nick step and starts identify" do
      fsm = advance(start_fsm(), [:start, {:nick_error, 433}, :settle])

      assert {_, [{:nick, :ok, nil}, {:identify, :running, nil}]} = hop(fsm, :nick_observed)
    end

    test "the bounded RETRY is silent — no visible churn in the modal" do
      # #623 — a 433/437 on the re-NICK sends the FSM back to await the verb.
      # The modal is told nothing, which is the point: a retry must not flicker.
      fsm = advance(start_fsm(), [:start, {:nick_error, 433}, :settle])

      assert {_, []} = hop(fsm, {:nick_error, 433})
    end
  end

  describe "terminals that reconcile every started step" do
    test "a deadline in :awaiting_r blames the identify step, not the nick" do
      # The NICK landed clean (no 433/437 ever came), so `+r` missing means the
      # IDENTIFY was refused.
      fsm = advance(start_fsm(), [:start])

      assert {_, [{:nick, :ok, nil}, {:identify, :failed, :wrong_password}]} =
               hop(fsm, :timeout)
    end

    test "a deadline in :awaiting_final_r blames identify with the reclaim reason" do
      # The nick WAS reclaimed, so this is not a wrong password: the sameNick
      # IDENTIFY simply went unconfirmed.
      fsm = advance(start_fsm(), [:start, {:nick_error, 433}, :settle, :nick_observed])

      assert {_, [{:nick, :ok, nil}, {:identify, :failed, :identify_unconfirmed}]} =
               hop(fsm, :timeout)
    end
  end

  # #1468 — the two terminals that do NOT reconcile every started step. Both
  # paths ran through `:idle -> :awaiting_r`, which set `identify: :running`,
  # and neither terminal ever gives that step a final status. cic upserts step
  # rows by name (`recoverProgress.ts`) and `RecoverModal` keeps rendering
  # `is-running` regardless of the outcome, so the modal ends with identify
  # spinning next to a failed result.
  #
  # This slice moves the projection AT PARITY: curing the defect here would be
  # a behaviour change hidden inside a refactor. The assertions below pin what
  # the code does today, and their names say it is a defect — the #1468 fix
  # turns them red, which is exactly what should happen.
  describe "terminals that strand a step (#1468 — moved here unchanged, not cured)" do
    test "#1468 — a deadline in :awaiting_verb_settle reports ONLY the verb" do
      fsm = advance(start_fsm(), [:start, {:nick_error, 433}])

      # Neither `identify` (running since the start) nor `nick` (running again
      # after a retry) is reconciled.
      assert {_, [{:recover, :failed, :services_declined}]} = hop(fsm, :timeout)
    end

    test "#1468 — a deadline in :awaiting_nick reports ONLY the nick" do
      fsm = advance(start_fsm(), [:start, {:nick_error, 433}, :settle])

      # `identify` has been :running since the start transition and stays there.
      assert {_, [{:nick, :failed, :nick_unavailable}]} = hop(fsm, :timeout)
    end
  end
end
