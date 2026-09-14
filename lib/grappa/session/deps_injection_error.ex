defmodule Grappa.Session.DepsInjectionError do
  @moduledoc """
  Raised by `Grappa.Session.Deps`'s two doors — `from_opts/2` when a
  session plan's set of injected closures does not match the set due for
  its subject tag, and `refresh!/2` when the `refresh_plan` closure is
  absent, mis-shaped, or answers with something its contract forbids.

  #1398 — the failure this exception exists to relocate. An injected
  callback is a bare closure, so it carries no module reference and
  `Boundary` cannot follow the edge: before this door, an omitted
  injection was not a compile error, not a crash and not a log line. It
  was a `nil` on the struct, and the first time anything reached for it
  the effect — an away snapshot, a credential commit, a rejoin snapshot —
  simply did not happen. Silently, in production, for as long as nobody
  compared the DB against the live session.

  `nil` could not be rejected wholesale because it is legitimate half the
  time: the two producers inject DISJOINT sets, so an absent
  `away_persister` is a bug on a user session and correct by construction
  on a visitor one. The subject tag is what tells the two apart, which is
  why the door takes it and why this exception reports it.

  Raised from `Server.init/1`'s `do_init/1`, i.e. at spawn, BEFORE the
  session is registered or the upstream socket is opened. A raise there
  makes `start_link/1` return `{:error, {exception, _stacktrace}}` and
  `DynamicSupervisor.start_child/2` propagate it: a child that never
  started is not restarted, so a mis-wired plan fails loudly and once
  instead of entering the `:transient` respawn loop. A LATER respawn
  cannot reach this state either — the supervisor replays the cached
  child spec and `refresh_plan`'s `Map.merge/2` can only add keys.

  Issue 2137 added a fifth fault, `bad_refresh`, and it is the only one
  that is not about the SET: `Grappa.Session.Deps.refresh!/2` is the one
  door that can check a closure's ANSWER rather than just its arity,
  because it is the door that invokes it. The fault stays on this
  exception rather than earning a module of its own — arity was already
  part of the contract these tables express ("a closure of the wrong
  shape fails at the call site, deep inside a running session"), and a
  wrong return shape is the same axis, just knowable one step later.
  """
  defexception [:subject_tag, :missing, :alien, :wrong_arity, :bad_refresh]

  @type t :: %__MODULE__{
          subject_tag: atom(),
          missing: [atom()],
          alien: [atom()],
          wrong_arity: [{atom(), non_neg_integer(), non_neg_integer()}],
          bad_refresh: {:returned, term()} | nil
        }

  @impl Exception
  def message(%__MODULE__{subject_tag: tag} = error) do
    "session plan for a :#{tag} subject carries a bad injected-closure set — " <>
      Enum.map_join(faults(error), "; ", fn {label, text} -> "#{label}: #{text}" end)
  end

  # Only the offending keys are named. An enumeration of the whole
  # expected set would read the same on every failure and would make a
  # test that asserts "names the missing key" pass vacuously.
  defp faults(%__MODULE__{} = error) do
    sections = [
      {"missing", Enum.join(List.wrap(error.missing), ", ")},
      {"not due on this tag", Enum.join(List.wrap(error.alien), ", ")},
      {"wrong arity", Enum.map_join(List.wrap(error.wrong_arity), ", ", &arity_fault/1)},
      {"refresh_plan returned a shape its contract forbids", refresh_fault(error.bad_refresh)}
    ]

    Enum.reject(sections, fn {_, text} -> text == "" end)
  end

  # `List.wrap/1` above, and this nil arm, because a raise names ONE fault
  # class and leaves the other four unset. Before the fifth was added every
  # raise site happened to pass all four lists, so `Enum.join(nil, _)` was
  # unreachable — a coupling nothing enforced, and exactly the kind that
  # turns the next raise site into an `ArgumentError` inside `message/1`,
  # i.e. an exception raised while rendering an exception.
  defp refresh_fault(nil), do: ""

  # Wrapped in `{:returned, _}` by the raise site, not stored bare: a
  # `refresh_plan` that answers `nil` IS one of the shapes this fault
  # exists to name, and a bare `nil` would be indistinguishable from the
  # field being unset — the message would then render no fault at all and
  # read as an empty accusation.
  #
  # Truncated: the offending value can be a whole credential struct, and an
  # unbounded `inspect` would bury the sentence that names the fault.
  defp refresh_fault({:returned, other}), do: inspect(other, limit: 4, printable_limit: 120)

  defp arity_fault({key, expected, got}), do: "#{key} (expected #{expected}, got #{got})"
end
