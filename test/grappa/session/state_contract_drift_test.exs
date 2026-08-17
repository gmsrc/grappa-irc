defmodule Grappa.Session.StateContractDriftTest do
  @moduledoc """
  Drift pin for `Session.Server`'s state contract (#1390 bucket A).

  The module declares its state twice — once as `@type t :: %{...}` and
  once as the map its init path builds — and nothing keeps the two in
  agreement. That is the mechanism behind the bucket's central sentence:
  renaming a `*_pending` field produces no compile error and no warning,
  only a `nil` at runtime in whichever `apply_effects/2` arm drains it.
  Both halves are bare maps, so neither the compiler nor Dialyzer has
  anything to disagree with.

  Measured on `origin/main` = `f75b0e05` before this test existed: the
  two sides declare **71** keys each and their set difference is empty in
  both directions. So the agreement is currently intact and unguarded —
  this pin buys the guard, not a fix.

  DERIVED from both sources, never manifested (CLAUDE.md — derive, don't
  duplicate): a hand-kept key list here would be a third copy to drift.
  The declared side is read from the COMPILED typespec
  (`Code.Typespec.fetch_types/1`, the same mechanism as
  `GrappaWeb.ErrorTokensDriftTest`) so it is the type Dialyzer sees, not
  a re-parse of the source; the built side has to be AST-walked, because
  it is a bound variable in a 3-tuple return and no introspection reaches
  it.

  The walk is anchored on the RETURN, not on a function name: the state
  map is the one bound to `state` in the function that answers
  `{:ok, state, {:continue, _}}`. Today that is `do_init/1`, not `init/1`
  — `init/1` delegates through `init_or_hold/1` — and pinning the name
  was this test's own first bug, caught by its own guard rather than by
  review. A semantic anchor survives renaming the delegate; restructuring
  the return breaks it loudly, which is the trade wanted here.

  That indirection is also why this test exists rather than a reuse.
  `Grappa.Deploy.Preflight` already walks both shapes, but its clause
  collects `{:ok, %{...}}` LITERALS returned by `init/1`, and this module
  neither returns a literal nor builds the map in `init/1` at all.
  Preflight sees the typedef — enough for its own job, classifying the
  deploy COLD — and never the state map, so it cannot serve as the oracle
  here.
  """

  # async: true — one file read, one typespec fetch, no Repo, no process,
  # no global state.
  use ExUnit.Case, async: true

  @server_source "lib/grappa/session/server.ex"

  test "Session.Server's @type t and the map its init path builds declare the same keys" do
    declared = declared_keys()
    built = built_keys()

    # Instrument the instrument: an extractor that quietly finds nothing
    # would make every assertion below vacuously true, forever. These two
    # keys are load-bearing enough that their disappearance is a real
    # failure rather than a rename — `EventRouter`'s own declared contract
    # requires both.
    assert :subject in declared and :network_id in declared,
           "the @type t extractor found no recognisable state keys — it is broken, " <>
             "not the contract"

    assert :subject in built and :network_id in built,
           "the init-map extractor found no recognisable state keys — it is broken, " <>
             "not the contract"

    undeclared = built |> MapSet.difference(declared) |> Enum.sort()
    unbuilt = declared |> MapSet.difference(built) |> Enum.sort()

    assert undeclared == [] and unbuilt == [],
           """
           Session.Server's state contract drifted.

           Built by the init path but MISSING from `@type t` (declare them):
             #{inspect(undeclared)}

           Declared in `@type t` but never built by the init path (remove
           them, or build them — a declared-only key reads as `nil` forever):
             #{inspect(unbuilt)}
           """
  end

  # ── declared side (the COMPILED typespec) ───────────────────────────

  defp declared_keys do
    {:ok, types} = Code.Typespec.fetch_types(Grappa.Session.Server)

    {:type, {:t, ast, _}} =
      Enum.find(types, fn
        {:type, {:t, _, _}} -> true
        _ -> false
      end)

    map_keys(ast)
  end

  # Erlang abstract-form typespec AST, as returned by
  # Code.Typespec.fetch_types/1: `%{key: value}` in Elixir is an EXACT
  # map field (`#{key := value}`), so an associative field would mean the
  # typedef changed shape rather than the key set — and it lands in
  # neither set, which the anchor assertions above catch.
  defp map_keys({:type, _, :map, fields}) do
    for {:type, _, :map_field_exact, [{:atom, _, key}, _]} <- fields,
        into: MapSet.new(),
        do: key
  end

  # ── built side (AST-walk the init path) ─────────────────────────────

  defp built_keys do
    maps =
      @server_source
      |> File.read!()
      |> Code.string_to_quoted!()
      |> init_state_maps()

    case maps do
      [kvs] ->
        for {key, _} <- kvs, is_atom(key), into: MapSet.new(), do: key

      found ->
        flunk("""
        expected exactly one `state = %{...}` literal in the function of
        #{@server_source} that answers `{:ok, state, {:continue, _}}`, found
        #{length(found)}. The extractor is anchored on that return, not on a
        function name; if the init path legitimately builds its state some
        other way now, teach this test the new shape — do not delete the pin.
        """)
    end
  end

  defp init_state_maps(ast) do
    {_, found} =
      Macro.prewalk(ast, [], fn
        {kind, _, [_, _]} = node, acc when kind in [:def, :defp] ->
          if returns_init_tuple?(node),
            do: {node, state_assignments(node) ++ acc},
            else: {node, acc}

        node, acc ->
          {node, acc}
      end)

    found
  end

  # The GenServer init return, `{:ok, state, {:continue, _}}` — a 3-tuple,
  # so `{:{}, _, [...]}` in quoted form. This is the anchor: whichever
  # function answers it is the one that built the state map, whatever it
  # is called.
  defp returns_init_tuple?(node) do
    {_, hit} =
      Macro.prewalk(node, false, fn
        {:{}, _, [:ok, {:state, _, ctx}, {:continue, _}]} = n, _ when is_atom(ctx) ->
          {n, true}

        n, acc ->
          {n, acc}
      end)

    hit
  end

  defp state_assignments(init_node) do
    {_, found} =
      Macro.prewalk(init_node, [], fn
        {:=, _, [{:state, _, ctx}, {:%{}, _, kvs}]} = node, acc
        when is_atom(ctx) and is_list(kvs) ->
          {node, [kvs | acc]}

        node, acc ->
          {node, acc}
      end)

    found
  end
end
