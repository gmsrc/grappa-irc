defmodule Grappa.Session.StateContractDriftTest do
  @moduledoc """
  Drift pin for `Session.Server`'s state contract (#1390 bucket A) and for
  the ONE half of `EventRouter`'s projection that no type system can see
  (issue 2132).

  ## The second face, and why it is only a HALF (issue 2132)

  `EventRouter` runs on `Session.Server`'s state map. #1390 pinned the
  host's own two declarations against each other and said so in this
  moduledoc: the projection was the other face and nothing asserted
  anything about it. Closing that face turned out to need two different
  tools, because the router reaches into the map through forms with
  OPPOSITE failure modes — measured, in the container:

      state.absent            -> KeyError              LOUD
      %{state | absent: 1}    -> KeyError              LOUD
      %{absent: x} = state    -> FunctionClauseError   LOUD
      Map.get(state, :absent) -> nil                   SILENT
      Map.get(state, :absent, [])  -> []               SILENT, and worse:
                                                       a plausible default

  The LOUD forms are Dialyzer's job, and they became Dialyzer's job in the
  same change: `EventRouter.@type state` is now `Session.Server.t()` rather
  than a hand-written projection ending in `optional(any()) => any()`, which
  was inhabited by every map and therefore checked nothing. Measured by
  renaming `whois_pending` in the host's `@type t` alone: 0 errors on the
  unmutated tree, 2 (both in `server.ex`) with the old projection, and 6
  with the unified type — the three new ones being the router's three
  `%{state | whois_pending: …}` sites, an exact 3-for-3.

  So this test deliberately pins ONLY the silent half: the keys reached by
  `Map.get/Map.put` on the state variable. Same rename, same tree, under the
  unified type: the router's SEVEN `Map.get(state, :whois_pending, …)` sites
  produce ZERO Dialyzer errors. Nothing but a test can see them.

  **It is scoped that way on purpose.** Re-asserting here what Dialyzer
  already proves would be a second copy of a fact, and a second copy is a
  thing that drifts (CLAUDE.md — derive, don't duplicate).

  SUBSET, not equality, and that is not a softening: 44 of the host's 82
  declared keys are never reached by the router (`client`, `autojoin`,
  `tls`, `peer_address`, `subject_label`, …). A key the router reaches and
  the host does not declare is a bug; a key the host declares and the router
  ignores is none of the router's business, and equality would redden on
  every field added to the host.

  ### Known limit of the router walk — stated here rather than discovered

  The walk is anchored on a variable literally named `state`. A function
  head that destructures the state map WITHOUT binding it — `defp f(%{isupport:
  x})` — is invisible to it. Measured at the time of writing: every
  destructuring site in the router binds `state`, so the exposure is real
  but empty today. The cardinality floor below is the mitigation: it catches
  the walk going blind wholesale, though not one site drifting out of reach.

  ## Drift pin for `Session.Server` itself (#1390 bucket A)

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
  @router_source "lib/grappa/session/event_router.ex"

  # Measured floors for the router walk (issue 2132). See the assertion for
  # why these are floors and not equalities.
  @router_read_floor 31
  @router_create_floor 8

  # The Map functions that READ a key (silent when it is absent) and the ones
  # that CREATE it. Split because the two make different claims about the
  # contract, and the split is asserted exhaustive below: a Map function used
  # on the state variable and named in neither list fails the walk rather
  # than being dropped from it.
  @map_reads ~w(get get_lazy fetch fetch! has_key?)a
  @map_creates ~w(put put_new merge)a

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

  test "every state key EventRouter reaches SILENTLY is declared by Session.Server" do
    declared = declared_keys()
    %{read: read, created: created} = router_silent_keys()

    # Instrument the instrument, three ways. Without these a walk that
    # quietly stopped matching would make both subset assertions vacuously
    # true — and the empty set is a subset of everything, which is the exact
    # way this kind of gate dies.
    assert MapSet.subset?(MapSet.new([:isupport, :ignores]), read),
           "the Map.get walk found neither :isupport nor :ignores — it is broken, " <>
             "not the contract"

    # A FLOOR, not an equality: growth is fine and needs no edit, while a
    # DROP means the walk went blind. Measured at #{@router_read_floor} when this was
    # written; if a refactor legitimately removes reads, lower it in the
    # same commit and say which ones went.
    assert MapSet.size(read) >= @router_read_floor,
           "the Map.get walk derived only #{MapSet.size(read)} keys, below the measured " <>
             "floor of #{@router_read_floor} — suspect the extractor before the code"

    assert MapSet.size(created) >= @router_create_floor,
           "the Map.put walk derived only #{MapSet.size(created)} keys, below the measured " <>
             "floor of #{@router_create_floor} — suspect the extractor before the code"

    # NEGATIVE control, kept after the defect it names was already gone. The
    # first census of this surface was a grep, and it invented `:entries` out
    # of a NESTED `%{accum | entries: …}` sitting inside
    # `%{state | links_pending: …}`. A base-anchored AST walk cannot see it;
    # this asserts that property rather than trusting it, so a rewrite that
    # loses it fails here instead of inflating the set.
    refute MapSet.member?(MapSet.union(read, created), :entries),
           "the walk matched :entries — it is no longer anchored on the state variable " <>
             "and is reading nested map updates"

    # Two claims, deliberately separate: a READ of an undeclared key yields
    # nil forever, a Map.put of one INJECTS a field the host never declared.
    undeclared_reads = read |> MapSet.difference(declared) |> Enum.sort()

    assert undeclared_reads == [],
           """
           EventRouter reads state keys Session.Server does not declare.

           `Map.get(state, :key)` returns nil (or your default) for a key that
           is not there — no crash, no warning, no Dialyzer error. Whatever
           arm drains these reads it silently no-ops:
             #{inspect(undeclared_reads)}
           """

    injected = created |> MapSet.difference(declared) |> Enum.sort()

    assert injected == [],
           """
           EventRouter injects state keys Session.Server does not declare.

           `Map.put(state, :key, v)` CREATES the key, so this is not a read
           that goes nil — it is the router growing the host's state behind
           the host's own contract. #1390's pin cannot see it either: such a
           key is neither declared by `@type t` nor built by the init path.
             #{inspect(injected)}
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

  # ── the router's SILENT surface (issue 2132) ────────────────────────
  #
  # Both spellings of the same call, because the router uses both:
  #   Map.get(state, :key, default)      and      state |> Map.get(:key)
  # Anchored on the `state` VARIABLE in argument position, which is what
  # keeps a nested `%{accum | …}` or a `Map.get(state.members, …)` out —
  # the latter reads a key of a nested map, not of the state.
  defp router_silent_keys do
    ast = @router_source |> File.read!() |> Code.string_to_quoted!()

    {_, hits} =
      Macro.prewalk(ast, [], fn
        {{:., _, [{:__aliases__, _, [:Map]}, fun]}, _, [base, key | _]} = node, acc
        when is_atom(key) ->
          if state_var?(base), do: {node, [{fun, key} | acc]}, else: {node, acc}

        {:|>, _, [base, {{:., _, [{:__aliases__, _, [:Map]}, fun]}, _, [key | _]}]} = node, acc
        when is_atom(key) ->
          if state_var?(base), do: {node, [{fun, key} | acc]}, else: {node, acc}

        node, acc ->
          {node, acc}
      end)

    unclassified =
      hits |> Enum.map(&elem(&1, 0)) |> Enum.uniq() |> Enum.reject(&(&1 in @map_reads ++ @map_creates))

    if unclassified != [] do
      flunk("""
      the router calls Map.#{inspect(unclassified)} on the state variable, and
      this test has no opinion about what that claims. Classify each one as a
      READ (silent when the key is absent) or a CREATE (the key need not
      exist) in @map_reads / @map_creates — do not widen a list to make this
      pass, the two sets carry different assertions on purpose.
      """)
    end

    %{
      read: for({f, k} <- hits, f in @map_reads, into: MapSet.new(), do: k),
      created: for({f, k} <- hits, f in @map_creates, into: MapSet.new(), do: k)
    }
  end

  defp state_var?({:state, _, ctx}) when is_atom(ctx), do: true
  defp state_var?(_), do: false

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
