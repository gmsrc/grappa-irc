defmodule Grappa.ReleaseTest do
  @moduledoc """
  The deploy scripts — and, since #1158, the operator CLI that ships AS
  `bin/grappa` — invoke `Grappa.Release` entry points as STRINGS
  inside `bin/grappa eval '...'`. Nothing links the two at compile time:
  rename or drop a function here and every substrate that runs a packaged
  release keeps calling the old name, failing only at deploy time, on the
  jail and the published image, where a shell hook's non-zero exit may be
  deliberately non-fatal (#440's seed warns and continues) — so the call
  can rot in silence.

  This closes that gap by deriving the expectation from the scripts
  themselves rather than a hand-kept list, so a future entry point is
  covered the day a deploy script starts naming it.
  """
  use ExUnit.Case, async: true

  @deploy_scripts [
    "infra/freebsd/deploy.sh",
    "infra/linux/deploy.sh",
    "infra/docker/deploy.sh",
    "scripts/deploy.sh",
    # Not a deploy script but the same hazard, and worse (#1158): this one
    # SHIPS as `bin/grappa`, so a rename here rots on every substrate at
    # once, and only when an operator reaches for the account door.
    "infra/release/grappa.sh"
  ]

  # `Grappa.Release.foo()` / `Grappa.Release.foo(args)` as written inside
  # an eval string.
  @call_re ~r/Grappa\.Release\.([a-z_][a-z0-9_]*)\s*\(/

  defp referenced_functions do
    @deploy_scripts
    |> Enum.flat_map(fn rel ->
      rel
      |> File.read!()
      |> then(&Regex.scan(@call_re, &1))
      |> Enum.map(fn [_, fun] -> {rel, String.to_atom(fun)} end)
    end)
    |> Enum.uniq()
  end

  test "every deploy script listed here exists" do
    # Guards the guard: a renamed or moved script would silently empty the
    # scan below and the whole suite would pass while proving nothing.
    for rel <- @deploy_scripts do
      assert File.exists?(rel), "deploy script #{rel} is gone — fix @deploy_scripts"
    end
  end

  test "the scan actually finds release entry points in the deploy scripts" do
    refs = referenced_functions()

    refute refs == [],
           "no Grappa.Release.*() call found in any deploy script — either the " <>
             "release path stopped using them (delete this test) or the regex rotted"
  end

  test "every Grappa.Release function a deploy script invokes is exported" do
    exported = Grappa.Release.__info__(:functions)

    for {script, fun} <- referenced_functions() do
      assert Keyword.has_key?(exported, fun),
             "#{script} invokes Grappa.Release.#{fun}() but Grappa.Release exports " <>
               "no such function — that deploy step would crash on the substrate " <>
               "that runs a packaged release. Exported: #{inspect(Keyword.keys(exported))}"
    end
  end
end
