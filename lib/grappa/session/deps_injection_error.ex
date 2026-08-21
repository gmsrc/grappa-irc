defmodule Grappa.Session.DepsInjectionError do
  @moduledoc """
  Raised by `Grappa.Session.Deps.from_opts/2` when a session plan's set of
  injected closures does not match the set due for its subject tag.

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
  """
  defexception [:subject_tag, :missing, :alien, :wrong_arity]

  @type t :: %__MODULE__{
          subject_tag: atom(),
          missing: [atom()],
          alien: [atom()],
          wrong_arity: [{atom(), non_neg_integer(), non_neg_integer()}]
        }

  @impl Exception
  def message(%__MODULE__{subject_tag: tag} = error) do
    "session plan for a :#{tag} subject carries a bad injected-closure set — " <>
      Enum.map_join(faults(error), "; ", fn {label, text} -> "#{label}: #{text}" end)
  end

  # Only the offending keys are named. An enumeration of the whole
  # expected set would read the same on every failure and would make a
  # test that asserts "names the missing key" pass vacuously.
  defp faults(%__MODULE__{missing: missing, alien: alien, wrong_arity: wrong_arity}) do
    sections = [
      {"missing", Enum.join(missing, ", ")},
      {"not due on this tag", Enum.join(alien, ", ")},
      {"wrong arity", Enum.map_join(wrong_arity, ", ", &arity_fault/1)}
    ]

    Enum.reject(sections, fn {_, text} -> text == "" end)
  end

  defp arity_fault({key, expected, got}), do: "#{key} (expected #{expected}, got #{got})"
end
