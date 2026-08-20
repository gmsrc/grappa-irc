defmodule Grappa.AdminEventsDirtSourcesTest do
  @moduledoc """
  Census pin for who may write `Grappa.AdminEvents`' singleton state
  from a test (#1546).

  `Grappa.AdminEvents` is started by `Grappa.Application` and outlives
  every sandbox checkout, so `persist` / `retention` written by one test
  are still there for the next FILE. `persist: true` escaping is not a
  cosmetic leak: the singleton then writes to the Repo from its own pid,
  which is `Sandbox.allow`ed only inside `admin_events_test.exs`, so it
  dies inside some unrelated file's `setup` — a cascade whose failure
  text names a file that did nothing wrong (#1613 is the sibling defect
  that erases the reason).

  The root fix for that is a restore registered as an `on_exit`, off the
  test's happy path, in the ONE file that writes those fields. That
  argument only holds while "the ONE file" stays true — which is exactly
  what this pin measures. A new file that starts writing the singleton's
  state has re-opened the class and needs its own `on_exit`.

  DERIVED, not manifested (CLAUDE.md — derive, don't duplicate): the
  writer set is grepped out of `test/` rather than hand-listed, so a new
  file is caught by the glob and not by anyone remembering to update a
  list. The allowed sites are asserted NON-EMPTY too — a rename that
  made the anchor stop matching would otherwise turn this pin green by
  matching nothing at all.

  ## What the anchor cannot see

  `:sys.replace_state/2` reached through a pid bound earlier (e.g.
  `pid = Process.whereis(AdminEvents)`) is invisible to a textual
  anchor. No such site exists today (the two allowed files both name
  the module inline); the pin is a tripwire on the cheap, common shape,
  not a proof of impossibility.
  """

  # async: true — pure file reads, no global state.
  use ExUnit.Case, async: true

  @test_glob "test/**/*.{ex,exs}"

  # Written by hand rather than derived: this IS the census the pin
  # freezes. Adding a path here is the review moment the pin exists to
  # force.
  @allowed [
    # The shared reset verb itself — the sanctioned way back to a
    # booted struct.
    "test/support/admission_state_helpers.ex",
    # The only file that dirties `persist` / `retention`, and the one
    # whose setup registers the file-wide `on_exit` restore.
    "test/grappa/admin_events_test.exs"
  ]

  # This file spells the anchor in its own source (in prose, and in the
  # pattern below). It writes nothing.
  @self "test/grappa/admin_events_dirt_sources_test.exs"

  @anchor ~r/:sys\.replace_state\(\s*(?:Grappa\.)?AdminEvents\b/

  test "only the censused files write the AdminEvents singleton's state" do
    by_file = writers()

    assert Map.keys(by_file) |> Enum.sort() == Enum.sort(@allowed),
           """
           A file outside the #1546 census writes `Grappa.AdminEvents`'
           singleton state via :sys.

           found:   #{inspect(Enum.sort(Map.keys(by_file)))}
           allowed: #{inspect(Enum.sort(@allowed))}

           If the new file dirties `persist` or `retention`, register a
           restore as an `on_exit` (never a straight-line statement in
           the test body — a failing assertion above it skips it) and
           add the path to @allowed. If it only empties the ring, call
           `AdmissionStateHelpers.reset_admin_events/0` instead.
           """
  end

  test "each censused file still writes it — the pin is not matching nothing" do
    by_file = writers()

    for path <- @allowed do
      assert Map.get(by_file, path, 0) > 0,
             "#{path} no longer writes the AdminEvents singleton via :sys — " <>
               "either the anchor drifted (this pin now proves nothing) or the " <>
               "path belongs out of @allowed."
    end
  end

  defp writers do
    @test_glob
    |> Path.wildcard()
    |> Enum.reject(&(&1 == @self))
    |> Enum.map(fn path -> {path, length(Regex.scan(@anchor, File.read!(path)))} end)
    |> Enum.reject(fn {_, count} -> count == 0 end)
    |> Map.new()
  end
end
