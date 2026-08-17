defmodule Grappa.Session.RecoverProgress do
  @moduledoc """
  #1390 slice 4 — the projection from a `Grappa.Session.RecoverIdentity`
  transition to the progress steps the cic recover modal renders (#581).

  ## What this is

  One pure function: `(previous phase, next FSM state) -> [{step, status,
  reason}]`. `Session.Server` broadcasts each returned triple as a
  `recover_progress` event on the user topic; the client upserts one row per
  step name and flips it as later events arrive.

  It is a TRANSLATION between two vocabularies that must not learn each
  other. `RecoverIdentity` owns the phases (`:awaiting_r`,
  `:awaiting_verb_settle`, …) and knows nothing about a modal;
  `Grappa.Session.Wire` owns the wire types (`recover_step/0`,
  `recover_status/0`, `recover_reason/0`) and builds payloads without
  deciding which ones to send. Choosing which steps a transition implies is
  neither of those jobs, so it is this module's.

  ## Why it left `Session.Server`

  Twelve clauses of a hand-maintained table sat as two `defp` functions with
  a single caller inside a 7,136-line GenServer, so the only way to exercise
  them was to boot a session, a fake ircd and the Repo and read the
  broadcasts back. Out here `recover_progress_test.exs` drives the real FSM
  on plain `ExUnit.Case`, `async: true`, with no process and no database —
  and it can only stay that way while the projection stays pure. Nothing in
  it may reach for session state.

  ## Known defect carried over: #1468

  A terminal out of `:awaiting_verb_settle` or `:awaiting_nick` reports only
  one step, but EVERY path into those phases ran through
  `:idle -> :awaiting_r`, which already set `identify: :running`. The client
  never reconciles a row nobody updates, so the modal ends with `identify`
  spinning next to a failed outcome — the very thing #623 pt3 set out to
  prevent ("RECONCILE every in-flight step on terminal `:failed`").

  Slice 4 moved this table AT PARITY and deliberately did NOT cure it:
  a behaviour change buried in a refactor is invisible to a reviewer reading
  the diff for a move. The fix is #1468, bought by its own red.

  Boundary: inherits the parent `Grappa.Session` boundary — same pattern as
  sibling submodules `Server`, `EventRouter`, `RecoverIdentity`. No
  `use Boundary` here.
  """

  alias Grappa.Session.RecoverIdentity
  alias Grappa.Session.Wire, as: SessionWire

  @typedoc """
  One progress row for the modal: which step, what it is doing now, and the
  failure token when it failed.
  """
  @type step_entry ::
          {SessionWire.recover_step(), SessionWire.recover_status(), SessionWire.recover_reason() | nil}

  @doc """
  Maps an FSM transition (old phase → next state) to the progress step(s) the
  modal renders. Order mirrors the source-verified sequence: NICK + IDENTIFY
  go out together, `+r` is the success (`:register`), and a held nick detours
  through the reclaim verb. `verb` (`:recover | :release`) doubles as its own
  step atom.

  Transitions with nothing to show — the bounded retry above all — return
  `[]`: a retry must not flicker in the modal.
  """
  @spec steps(RecoverIdentity.phase(), RecoverIdentity.t()) :: [step_entry()]
  def steps(:idle, %{phase: :awaiting_r}),
    do: [{:nick, :running, nil}, {:identify, :running, nil}]

  def steps(:awaiting_r, %{phase: :awaiting_verb_settle, verb: verb}),
    do: [{:nick, :failed, nil}, {verb, :running, nil}]

  # #623 — the verb settled; the re-NICK goes out ALONE. Only the nick step
  # runs now — the identify step waits for `:nick_observed` (the sequencing
  # barrier), so the modal never shows identify running before the nick lands.
  def steps(:awaiting_verb_settle, %{phase: :awaiting_nick, verb: verb}),
    do: [{verb, :ok, nil}, {:nick, :running, nil}]

  # #623 — the re-NICK landed AND was observed → the sameNick IDENTIFY goes out.
  def steps(:awaiting_nick, %{phase: :awaiting_final_r}),
    do: [{:nick, :ok, nil}, {:identify, :running, nil}]

  def steps(_, %{phase: :succeeded}),
    do: [{:nick, :ok, nil}, {:identify, :ok, nil}, {:register, :ok, nil}]

  # #623 pt3 — RECONCILE every in-flight step on terminal :failed (not just one)
  # so the modal never strands a step at :running (the trace "hang"), keyed on
  # the phase we failed OUT of. Two of the five clauses below do not honour
  # that rule — see the #1468 note in the moduledoc.
  def steps(old, %{phase: :failed, reason: reason, verb: verb}),
    do: terminal_steps(old, verb, reason)

  # #623 — the retry (`:awaiting_nick` → `:awaiting_verb_settle`) and every
  # other transition are SILENT: no visible retry churn.
  def steps(_, _), do: []

  # #623 pt3 — the reconciled terminal step list, keyed on the phase we failed
  # OUT of, with the two reclaim legs kept DISTINCT + trace-diagnosable:
  #   * `:awaiting_r` — a clean NICK but `+r` never came → the IDENTIFY failed
  #     (`:wrong_password`); the nick itself landed clean (`:ok`).
  #   * `:awaiting_verb_settle` — the reclaim verb went unanswered → the verb
  #     failed (`:services_declined`). **#1468: `identify` — running since the
  #     start transition — is not reconciled here, nor is `nick` after a retry.**
  #   * `:awaiting_nick` — leg (a): the re-NICK never landed → the nick failed
  #     (`:nick_unavailable`). **#1468: `identify` is not reconciled here
  #     either; the comment this clause used to carry claimed the identify step
  #     never started, which no reachable path makes true.**
  #   * `:awaiting_final_r` — leg (b): the re-NICK landed but `+r` never
  #     confirmed → the identify failed (`:identify_unconfirmed`); the nick is
  #     already `:ok`.
  @spec terminal_steps(
          RecoverIdentity.phase(),
          RecoverIdentity.verb(),
          RecoverIdentity.reason()
        ) :: [step_entry()]
  defp terminal_steps(:awaiting_r, _, reason),
    do: [{:nick, :ok, nil}, {:identify, :failed, reason}]

  defp terminal_steps(:awaiting_verb_settle, verb, reason) when verb in [:recover, :release],
    do: [{verb, :failed, reason}]

  defp terminal_steps(:awaiting_nick, _, reason),
    do: [{:nick, :failed, reason}]

  defp terminal_steps(:awaiting_final_r, _, reason),
    do: [{:nick, :ok, nil}, {:identify, :failed, reason}]

  defp terminal_steps(_, _, reason),
    do: [{:nick, :failed, reason}]
end
