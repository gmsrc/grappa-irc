defmodule Mix.Tasks.Grappa.GenWireTypes do
  @shortdoc "Generate cicchetto/src/lib/wireTypes.ts from Grappa.*.Wire typespecs"

  @moduledoc """
  Walks every module under `lib/grappa/**/wire.ex`, parses `@type`
  declarations via Code.Typespec.fetch_types/1, emits a single
  deterministic TypeScript file at `cicchetto/src/lib/wireTypes.ts`.

  ## Usage

      mix grappa.gen_wire_types          # regenerate the file
      mix grappa.gen_wire_types --check  # exit 1 if committed file drifts

  ## Type mapping rules

  Standard Elixir scalars → TS scalars:

    * `String.t()` / `Ecto.UUID.t()` → `string`
    * `integer()` / `non_neg_integer()` / `pos_integer()` → `number`
    * `boolean()` → `boolean`
    * `nil` → `null`
    * atom literal `:foo` → string literal `"foo"`
    * atom union `:a | :b` → string union `"a" | "b"`
    * bare `atom()` → `string` (Jason serializes atoms as strings)
    * `[T]` → `T[]`
    * `T | nil` → `T | null`
    * nested `%{...}` → `{ ... }`
    * `required(:k) => T` (and `k: T` shorthand) → `k: T`
    * `optional(:k) => T` → `k?: T` (server may omit the key)
    * `DateTime.t()` → `string` (Jason → ISO-8601)
    * `term()` → `unknown`
    * bare `map()` → `Record<string, unknown>` (WARNING — defeats codegen purpose)

  Cross-module references resolve to a TS alias name (the type is
  emitted at its source module's section; the reference site just
  uses the alias).

  Pure atom-union `@type`s (and unions composing them) are ALSO emitted
  as `as const` arrays — see "Enum types" below.

  ## File shape

  Modules emitted in alphabetical order; types within a module in
  source order. Each module gets a `// === Grappa.X.Wire ===` header.
  When multiple `@type X_payload :: %{kind: :literal, ...}` exist in
  one module, codegen ALSO emits a `WireXEvent` discriminated union.

  ## Enum types → `as const` array + derived type (#411 D6b)

  A **(recursively-)enum** `@type` — a union whose every member is an
  atom literal (≠ `nil`/`true`/`false`) OR a same-module `user_type`
  ref to another enum — is emitted as a runtime `as const` array PLUS a
  type derived from it via `(typeof ARR)[number]`:

      export const REST_ERROR_TOKENS = [...SHARED_ERROR_TOKENS, "bad_request", …] as const;
      export type ErrorTokensRestErrorToken = (typeof REST_ERROR_TOKENS)[number];

  This collapses the three-parallel-structures problem in cicchetto's
  `friendly*Error.ts` (literal union + runtime narrowing `Set` +
  `switch`): the union and the `Set` now derive from ONE generated
  array. A composing enum SPREADS the referenced enum's const rather
  than re-inlining its literals (mirrors the Elixir `shared | specific`
  composition; the referenced const is emitted first because typedefs
  follow source order). The derived type is structurally identical to
  the old literal union, so consumers are unaffected. The const name is
  the SCREAMING_SNAKE of the type alias (1:1, so const + type can't
  drift). Two guards: **(a)** a cyclic ref RAISES with the type names in
  the cycle (never infinite recursion); **(b)** array element order is
  the declaration order (no sort/dedup) so regen output is stable and
  diffs don't flicker.
  """
  use Boundary, top_level?: true, deps: []

  use Mix.Task

  @output_path "cicchetto/src/lib/wireTypes.ts"
  @wire_glob "lib/grappa/**/wire.ex"

  # #411 D6b — the wire-token error space (`GrappaWeb.ErrorTokens`) is the
  # codegen source for the cicchetto client's error unions, but it lives in
  # the WEB layer on purpose (HTTP/Channel wire tokens are not domain data),
  # so it sits outside `@wire_glob`. Widen the source set to reach it
  # WITHOUT relocating the module into `lib/grappa/**/wire.ex` — a
  # boundary-preserving glob widen, not a file move.
  @extra_globs ["lib/grappa_web/error_tokens.ex"]

  @impl Mix.Task
  def run(argv) do
    {opts, _, _} = OptionParser.parse(argv, switches: [check: :boolean])
    Mix.Task.run("loadpaths")
    Mix.Task.run("compile")
    generated = generate()

    if opts[:check] do
      verify_committed(generated)
    else
      write_committed(generated)
    end
  end

  @doc false
  @spec generate() :: String.t()
  def generate do
    # Reset the per-run "external type referrers" registry — any
    # remote_type reference to a non-wire module is recorded here
    # during module rendering and emitted under a synthetic
    # "// === External types ===" section at the top.
    Process.put(:wire_external_refs, %{})

    body =
      (Path.wildcard(@wire_glob) ++ Enum.flat_map(@extra_globs, &Path.wildcard/1))
      |> Enum.sort()
      |> Enum.map(&module_from_path/1)
      |> Enum.reject(&is_nil/1)
      |> Enum.sort_by(&inspect/1)
      |> Enum.map(&render_module/1)
      |> Enum.reject(&(&1 == ""))
      |> Enum.join("\n\n")

    external = render_external_section()
    Process.delete(:wire_external_refs)

    [external, body]
    |> Enum.reject(&(&1 == ""))
    |> Enum.join("\n\n")
    |> wrap_with_header()
  end

  defp render_external_section do
    # Resolve to fixpoint: rendering an external type may introduce
    # new remote_type references to OTHER non-wire modules; keep
    # rendering until no new refs surface. Depth-limit at 8 to bail
    # on a pathological cycle.
    do_render_external_section(MapSet.new(), 1, 8)
  end

  defp do_render_external_section(_, depth, max_depth) when depth > max_depth do
    raise "wire_types codegen: external-type resolution exceeded depth #{max_depth} — likely cycle"
  end

  defp do_render_external_section(already_rendered, depth, max_depth) do
    refs = Process.get(:wire_external_refs, %{})

    new_refs =
      refs
      |> Map.keys()
      |> Enum.reject(&MapSet.member?(already_rendered, &1))

    if new_refs == [] do
      build_external_output(refs)
    else
      # Render new refs (which may add more refs); recurse.
      _ =
        Enum.map(new_refs, fn {mod, type} ->
          alias_name = Map.fetch!(refs, {mod, type})
          render_external_type(mod, type, alias_name)
        end)

      do_render_external_section(
        Enum.reduce(new_refs, already_rendered, &MapSet.put(&2, &1)),
        depth + 1,
        max_depth
      )
    end
  end

  defp build_external_output(refs) do
    if refs == %{} do
      ""
    else
      rendered =
        refs
        |> Enum.sort_by(fn {{mod, type}, _} -> "#{inspect(mod)}.#{type}" end)
        |> Enum.map(fn {{mod, type}, alias_name} ->
          render_external_type(mod, type, alias_name)
        end)
        |> Enum.reject(&(&1 == ""))

      if rendered == [] do
        ""
      else
        "// === External types (referenced by Wire modules) ===\n\n" <>
          Enum.join(rendered, "\n\n")
      end
    end
  end

  defp render_external_type(mod, type_name, alias_name) do
    with {:ok, types} <- Code.Typespec.fetch_types(mod),
         {_, {_, ast, _}} <-
           Enum.find(types, :error, fn {_, {name, _, _}} -> name == type_name end) do
      format_external_typedef(alias_name, ast)
    else
      :error ->
        "// MISSING: #{inspect(mod)} has no @type declarations"

      _ ->
        "// MISSING: #{inspect(mod)}.#{type_name}/0 — fix the source typespec"
    end
  end

  defp format_external_typedef(alias_name, ast) do
    stripped = strip_typespec_metadata(ast)

    # #411 D6b — the enum→array rule is structural, not location-scoped: a
    # pure atom-union external type (e.g. Networks.Credential.connection_state,
    # referenced from a Wire module) gets the SAME `as const` array + derived
    # type as a wire-module enum. External types are rendered one-at-a-time by
    # alias with no same-module sibling registry, so a COMPOSING enum (one that
    # spreads a sibling enum's const) can't be HANDLED here — it would emit a
    # plain typedef. Every external enum today is a pure atom union, so this is
    # unobservable; if a future external module gains a composing enum, promote
    # it into a `**/wire.ex` module (which has the registry) rather than
    # teaching the external path to resolve refs.
    case pure_atom_union_arms(stripped) do
      {:ok, arms} -> emit_enum(alias_name, arms)
      :error -> format_plain_typedef(alias_name, stripped)
    end
  end

  defp format_plain_typedef(alias_name, stripped) do
    body = do_render(stripped)
    sep = if String.starts_with?(body, "\n"), do: "", else: " "
    inline_candidate = "export type #{alias_name} = #{body};"

    cond do
      String.starts_with?(body, "{") -> "export type #{alias_name} = #{body};"
      String.starts_with?(body, "\n") -> "export type #{alias_name} =#{sep}#{body};"
      String.length(inline_candidate) <= 100 -> inline_candidate
      String.contains?(body, " | ") -> reformat_to_multiline(alias_name, body)
      true -> inline_candidate
    end
  end

  # A real union of ONLY atom literals (≠ nil/true/false) → its quoted-string
  # arms; anything else → :error (stays a plain typedef). Used by the external
  # path, which has no sibling registry to resolve enum-ref composition.
  defp pure_atom_union_arms({:|, _, _} = union) do
    arms = flatten_union(union, [])

    if Enum.all?(arms, &atom_literal_arm?/1) do
      {:ok, Enum.map(arms, fn {:atom, _, [a]} -> ~s("#{Atom.to_string(a)}") end)}
    else
      :error
    end
  end

  defp pure_atom_union_arms(_), do: :error

  defp atom_literal_arm?({:atom, _, [a]}) when a not in [nil, true, false], do: true
  defp atom_literal_arm?(_), do: false

  defp reformat_to_multiline(alias_name, body) do
    multi = String.replace(body, " | ", "\n  | ")
    "export type #{alias_name} =\n  | #{multi};"
  end

  defp module_from_path(path) do
    parts =
      path
      |> Path.rootname()
      |> String.replace_prefix("lib/", "")
      |> Path.split()
      |> Enum.map(&camelize_path_segment/1)

    mod = Module.concat(parts)
    if Code.ensure_loaded?(mod), do: mod, else: nil
  rescue
    _ -> nil
  end

  defp camelize_path_segment(seg) do
    seg |> String.split("_") |> Enum.map_join("", &String.capitalize/1)
  end

  defp wrap_with_header(body) do
    """
    // GENERATED FILE — DO NOT EDIT
    // Run `scripts/mix.sh grappa.gen_wire_types` to regenerate.
    // Source: lib/grappa/**/wire.ex + lib/grappa_web/error_tokens.ex

    #{body}
    """
  end

  defp write_committed(content) do
    File.write!(@output_path, content)
    Mix.shell().info("Wrote #{@output_path}")
  end

  defp verify_committed(generated) do
    case File.read(@output_path) do
      {:ok, committed} when committed == generated ->
        Mix.shell().info("#{@output_path} is in sync.")

      {:ok, _} ->
        Mix.shell().error("""
        #{@output_path} is OUT OF SYNC with the Wire typespecs.

        Run `scripts/mix.sh grappa.gen_wire_types` and commit the
        result.
        """)

        exit({:shutdown, 1})

      {:error, :enoent} ->
        Mix.shell().error("#{@output_path} does not exist — run `mix grappa.gen_wire_types`")
        exit({:shutdown, 1})
    end
  end

  ## ----- Module renderer ---------------------------------------------------

  defp render_module(mod) do
    case Code.Typespec.fetch_types(mod) do
      {:ok, types} -> render_typedefs(mod, exported_typedefs(types))
      :error -> ""
    end
  end

  # Filter to publicly-exported @type entries only (skip @typep / @opaque).
  # Code.Typespec.fetch_types/1 returns the list in REVERSE source order;
  # un-reverse so emitted typedefs match the order an operator reads in the
  # .ex file.
  defp exported_typedefs(types) do
    for {kind, {name, ast, vars}} <- types, kind == :type do
      {name, ast, vars}
    end
    |> Enum.reverse()
  end

  defp render_typedefs(_, []), do: ""

  defp render_typedefs(mod, typedefs) do
    # #411 D6b — a per-module registry of STRIPPED asts keyed by type name, so
    # the enum resolver can follow same-module `user_type` refs (e.g.
    # rest_error_token → shared_error_token) to decide whether a type is a
    # (recursively-)enum and spread its array.
    types_by_name =
      Map.new(typedefs, fn {name, ast, _} -> {name, strip_typespec_metadata(ast)} end)

    rendered = Enum.map(typedefs, &render_typedef(mod, &1, types_by_name))
    union = render_kind_union(mod, typedefs)
    header = "// === #{inspect(mod)} ===\n\n"
    header <> Enum.join(rendered, "\n\n") <> union
  end

  defp render_typedef(mod, {name, ast, _}, types_by_name) do
    Process.put(:wire_current_module, mod)
    stripped = strip_typespec_metadata(ast)
    ts_name = render_alias_name(mod, name)

    # #411 D6b — a (recursively-)enum type is emitted as a runtime `as const`
    # array PLUS a type derived from it via `(typeof ARR)[number]`, so the
    # client's narrowing Set and its compile-time union share ONE generated
    # source. `classify_enum/2` follows same-module refs (raising loudly on a
    # cycle) — everything else stays a plain `export type`.
    result =
      case classify_enum(name, types_by_name) do
        {:enum, _} -> render_enum_typedef(mod, ts_name, stripped)
        :not_enum -> format_plain_typedef(ts_name, stripped)
      end

    Process.delete(:wire_current_module)
    result
  end

  # #411 D6b — enum emission: `export const SCREAMING = [...] as const;`
  # followed by `export type Alias = (typeof SCREAMING)[number];`. The const
  # is declared before any type/const that spreads it because typedefs are
  # emitted in source order and a composing enum lists its referenced enum
  # first (Elixir `shared | specific`). ORDER-DEPENDENT: if a composing enum
  # is ever declared BEFORE the enum it spreads, `...CONST` would precede
  # `const CONST` ("used before declaration") — tsc catches it, and the
  # SHARED-before-REST ordering test pins the ErrorTokens case.
  defp render_enum_typedef(mod, ts_name, stripped) do
    emit_enum(ts_name, enum_array_arms(stripped, mod))
  end

  defp emit_enum(ts_name, arms) do
    const_name = screaming_const_name(ts_name)
    array_line = format_const_array(const_name, arms)
    array_line <> "\n" <> format_derived_type(ts_name, const_name)
  end

  # biome wraps an over-long derived-type line at `=` with a 2-space
  # continuation indent (lineWidth: 100), e.g. the long
  # `NetworksCredentialConnectionState` alias.
  defp format_derived_type(ts_name, const_name) do
    inline = "export type #{ts_name} = (typeof #{const_name})[number];"

    if String.length(inline) <= 100 do
      inline
    else
      "export type #{ts_name} =\n  (typeof #{const_name})[number];"
    end
  end

  # biome array formatting at lineWidth: 100 with trailingCommas: "all".
  # Fits on one line → inline, no trailing comma. Otherwise → one element
  # per line, indent 2, trailing comma on EVERY element (incl. last).
  defp format_const_array(const_name, arms) do
    inline = "export const #{const_name} = [#{Enum.join(arms, ", ")}] as const;"

    if String.length(inline) <= 100 do
      inline
    else
      body = Enum.map_join(arms, "\n", fn arm -> "  #{arm}," end)
      "export const #{const_name} = [\n#{body}\n] as const;"
    end
  end

  # One array element per union arm, in source order: an atom literal → the
  # quoted string; a same-module enum ref → a `...SCREAMING` spread of that
  # enum's already-emitted const. classify_enum/2 guarantees every ref here
  # is itself an enum, so the spread target always exists.
  defp enum_array_arms(stripped, mod) do
    stripped
    |> flatten_enum_arms()
    |> Enum.map(fn
      {:atom, _, [a]} when a not in [nil, true, false] -> ~s("#{Atom.to_string(a)}")
      {:user_type, _, [ref]} -> "..." <> screaming_const_name(render_alias_name(mod, ref))
    end)
  end

  # Classify a type as a (recursively-)enum: a union whose every member is an
  # atom literal (≠ nil/true/false) OR a same-module `user_type` ref to
  # another enum, terminating in atoms. Returns `{:enum, :ok}` or `:not_enum`;
  # RAISES loudly (with the type names in the cycle) on a cyclic ref rather
  # than recursing forever (#411 guard a).
  defp classify_enum(name, types_by_name), do: resolve_enum(name, types_by_name, [])

  defp resolve_enum(name, types_by_name, stack) do
    if name in stack do
      cycle = Enum.map_join(Enum.reverse([name | stack]), " → ", &Atom.to_string/1)
      raise "gen_wire_types: cyclic enum reference: #{cycle}"
    end

    case Map.fetch(types_by_name, name) do
      # Only a real UNION is a candidate enum (matches the "union of atom
      # literals or enum refs" rule; a lone scalar/map/single-atom type is not).
      {:ok, {:|, _, _} = union} ->
        union
        |> flatten_union([])
        |> classify_enum_arms(types_by_name, [name | stack])

      {:ok, _} ->
        :not_enum

      # A ref to a type not declared in THIS module (remote/unknown) is not a
      # same-module enum — the composing type is therefore not an enum.
      :error ->
        :not_enum
    end
  end

  defp classify_enum_arms([], _, _), do: {:enum, :ok}

  defp classify_enum_arms([arm | rest], types_by_name, stack) do
    case arm do
      {:atom, _, [a]} when a not in [nil, true, false] ->
        classify_enum_arms(rest, types_by_name, stack)

      {:user_type, _, [ref]} ->
        case resolve_enum(ref, types_by_name, stack) do
          {:enum, :ok} -> classify_enum_arms(rest, types_by_name, stack)
          :not_enum -> :not_enum
        end

      # Any non-atom, non-enum-ref arm (map, remote type, scalar, nil,
      # boolean) means this type is not a clean string enum.
      _ ->
        :not_enum
    end
  end

  # A union flattens to its arms; a single non-union type is a one-arm list.
  defp flatten_enum_arms({:|, _, _} = union), do: flatten_union(union, [])
  defp flatten_enum_arms(other), do: [other]

  # CamelCase alias → SCREAMING_SNAKE const name (deterministic, 1:1 with the
  # type alias so the const and its type never drift apart).
  defp screaming_const_name(camel) do
    camel
    |> String.replace(~r/(?<=[a-z0-9])(?=[A-Z])/, "_")
    |> String.upcase()
  end

  # Convert Erlang abstract-form typespec AST (returned by
  # Code.Typespec.fetch_types/1) into the inner-AST shape our
  # do_render/1 pattern matches on.
  # See render_type/1 comment for the matching spec shape.
  @spec strip_typespec_metadata(
          nil
          | [nil | [nil | [any(), ...] | {atom(), any(), any()}, ...] | {atom(), any(), any()}, ...]
          | {atom(), any(), any()}
        ) ::
          nil
          | [nil | [nil | [any(), ...] | {atom(), any(), any()}, ...] | {atom(), any(), any()}, ...]
          | {atom(), any(), any()}
  # Bare `map()` — the Erlang abstract form carries `:any` (not `[]`) as its
  # field spec. Route it straight to the empty-map shape so `do_render/1` emits
  # `Record<string, unknown>` (the documented bare-map fallback) instead of
  # `strip_map/1` crashing on `Enum.all?(:any, …)`. A typed `%{...}` map still
  # carries a LIST of fields and falls through to the clause below.
  defp strip_typespec_metadata({:type, _, :map, :any}), do: {:map, [], []}
  defp strip_typespec_metadata({:type, _, :map, fields}), do: strip_map(fields)
  defp strip_typespec_metadata({:atom, _, value}) when is_atom(value), do: {:atom, [], [value]}

  defp strip_typespec_metadata({:type, _, :union, members}) do
    members
    |> Enum.map(&strip_typespec_metadata/1)
    |> Enum.reduce(fn r, l -> {:|, [], [l, r]} end)
  end

  defp strip_typespec_metadata({:type, _, :list, [inner]}), do: [strip_typespec_metadata(inner)]

  defp strip_typespec_metadata({:type, _, prim, []})
       when prim in [
              :integer,
              :non_neg_integer,
              :pos_integer,
              :boolean,
              :map,
              :binary,
              :atom,
              :term,
              :any
            ] do
    {prim, [], []}
  end

  defp strip_typespec_metadata({:remote_type, _, [{:atom, _, mod}, {:atom, _, type}, []]}) do
    {:remote_type, [], [mod, type]}
  end

  defp strip_typespec_metadata({:user_type, _, name, []}), do: {:user_type, [], [name]}

  defp strip_typespec_metadata({:type, _, :tuple, members}) do
    {:tuple, [], Enum.map(members, &strip_typespec_metadata/1)}
  end

  defp strip_typespec_metadata(other), do: other

  defp strip_map([]), do: {:map, [], []}

  defp strip_map(fields) do
    if Enum.all?(fields, &atom_keyed_field?/1) do
      {:%{}, [], Enum.map(fields, &strip_atom_keyed_field/1)}
    else
      [first | _] = fields
      {_, _, _, [key_ast, value_ast]} = first
      {:open_map, [], [strip_typespec_metadata(key_ast), strip_typespec_metadata(value_ast)]}
    end
  end

  # `optional(:k) => T` carries `:map_field_assoc`; `required(:k) => T`
  # (and the `k: T` shorthand) carries `:map_field_exact`. Preserve the
  # distinction so an omitted-when-absent key renders `k?: T`, not the
  # over-claiming `k: T`. See cross-surface S2.
  defp strip_atom_keyed_field({:type, _, :map_field_assoc, [k, v]}) do
    {{:optional, literal_key(k)}, strip_typespec_metadata(v)}
  end

  defp strip_atom_keyed_field({:type, _, :map_field_exact, [k, v]}) do
    {literal_key(k), strip_typespec_metadata(v)}
  end

  defp atom_keyed_field?({:type, _, _, [{:atom, _, _}, _]}), do: true
  defp atom_keyed_field?(_), do: false

  defp literal_key({:atom, _, key}) when is_atom(key), do: key

  ## ----- Type renderer -----------------------------------------------------

  # Dialyzer "contract_supertype" — render_type/1's success typing is
  # a structural narrowing of `any()` (it pattern-matches on N AST
  # shapes); Credo requires @spec, Dialyzer wants the spec narrower
  # than `any()`. Hand-rolling the precise union is brittle and would
  # need an edit per new do_render/1 clause. Use the precise AST union
  # form Dialyzer infers — kept in sync via this annotation comment if
  # do_render/1 grows new clauses.
  @doc false
  @spec render_type(
          nil
          | [nil | [nil | [any(), ...] | {atom(), any(), any()}, ...] | {atom(), any(), any()}, ...]
          | {atom(), any(), any()}
        ) :: String.t()
  def render_type(ast), do: do_render(ast)

  defp do_render(nil), do: "null"

  defp do_render({:atom, _, [a]}) when is_atom(a) and a not in [nil, true, false] do
    ~s("#{Atom.to_string(a)}")
  end

  defp do_render({:atom, _, [nil]}), do: "null"
  defp do_render({:atom, _, [true]}), do: "true"
  defp do_render({:atom, _, [false]}), do: "false"

  defp do_render({:|, _, _} = union) do
    arms = flatten_union(union, [])
    rendered = Enum.map(arms, &do_render/1)
    Enum.join(rendered, " | ")
  end

  # Remote type references (rendered as TS alias names where possible)
  defp do_render({:remote_type, _, [String, :t]}), do: "string"
  defp do_render({:remote_type, _, [DateTime, :t]}), do: "string"
  defp do_render({:remote_type, _, [Date, :t]}), do: "string"
  defp do_render({:remote_type, _, [NaiveDateTime, :t]}), do: "string"
  defp do_render({:remote_type, _, [Ecto.UUID, :t]}), do: "string"

  defp do_render({:remote_type, _, [mod, type]}) when is_atom(mod) and is_atom(type) do
    alias_name = render_alias_name(mod, type)
    register_external_ref(mod, type, alias_name)
    alias_name
  end

  # User-defined type (within same module) — emitted at its source
  # site with the same module-prefix convention; we use the same
  # alias-name shape so the reference resolves to the emitted name.
  # Caller must pass the source module via Process dict (set per
  # render_typedef/2 invocation).
  defp do_render({:user_type, _, [name]}) when is_atom(name) do
    case Process.get(:wire_current_module) do
      nil -> camelize(Atom.to_string(name))
      mod -> render_alias_name(mod, name)
    end
  end

  defp do_render({:integer, _, []}), do: "number"
  defp do_render({:non_neg_integer, _, []}), do: "number"
  defp do_render({:pos_integer, _, []}), do: "number"
  defp do_render({:boolean, _, []}), do: "boolean"
  defp do_render({:binary, _, []}), do: "string"
  defp do_render({:atom, _, []}), do: "string"
  defp do_render({:term, _, []}), do: "unknown"
  defp do_render({:any, _, []}), do: "unknown"

  defp do_render({:map, _, []}) do
    IO.warn("bare map() in Wire typespec — codegen falling back to Record<string, unknown>")
    "Record<string, unknown>"
  end

  defp do_render({:tuple, _, members}) do
    "[" <> Enum.map_join(members, ", ", &do_render/1) <> "]"
  end

  defp do_render([t]), do: "#{do_render(t)}[]"

  defp do_render({:open_map, _, [_, value_ast]}) do
    # JSON object maps always have string keys on the wire (Jason
    # converts integer keys to strings; atom keys to strings). Render
    # as Record<string, V> regardless of source key type.
    "Record<string, #{do_render(value_ast)}>"
  end

  defp do_render({:%{}, _, fields}) do
    body =
      Enum.map_join(fields, "\n", fn
        {{:optional, k}, v} when is_atom(k) -> "  #{k}?: #{do_render(v)};"
        {k, v} when is_atom(k) -> "  #{k}: #{do_render(v)};"
      end)

    "{\n#{body}\n}"
  end

  defp register_external_ref(mod, type, alias_name) do
    # Skip refs that already render via wire-module emission. If `mod`
    # is under `lib/grappa/**/wire.ex`, its types are emitted in their
    # own module section.
    if wire_module?(mod) do
      :ok
    else
      refs = Process.get(:wire_external_refs, %{})
      Process.put(:wire_external_refs, Map.put_new(refs, {mod, type}, alias_name))
      :ok
    end
  end

  defp wire_module?(mod) do
    case mod |> Module.split() |> List.last() do
      "Wire" -> true
      _ -> false
    end
  end

  defp flatten_union({:|, _, [l, r]}, acc), do: flatten_union(l, flatten_union(r, acc))
  defp flatten_union(other, acc), do: [other | acc]

  ## ----- Aliases & helpers -------------------------------------------------

  defp render_alias_name(mod, type_name) do
    # Grappa.AdminEvents.Wire + :event_kind → AdminEventsEventKind
    short =
      mod
      |> Module.split()
      |> tl()
      |> Enum.map_join("", & &1)

    short <> camelize(Atom.to_string(type_name))
  end

  defp camelize(snake) do
    snake |> String.split("_") |> Enum.map_join("", &String.capitalize/1)
  end

  defp render_kind_union(mod, typedefs) do
    # Skip auto-emission if the source module ALREADY declares a
    # discriminator-shaped union type (any @type X :: %{...} | %{...} |
    # ...). The user-declared union owns the surface; auto-emission
    # would duplicate.
    if user_declared_union?(typedefs) do
      ""
    else
      arms = literal_kind_arms(typedefs)

      if length(arms) >= 2 do
        emit_auto_union(mod, arms)
      else
        ""
      end
    end
  end

  defp literal_kind_arms(typedefs) do
    for {name, ast, _} <- typedefs,
        {:ok, _} <- [extract_literal_kind(ast)] do
      name
    end
  end

  defp emit_auto_union(mod, arms) do
    union_name = mod_to_event_union_name(mod)
    rendered_arms = Enum.map(arms, fn name -> render_alias_name(mod, name) end)
    inline = Enum.join(rendered_arms, " | ")
    inline_line = "export type #{union_name} = #{inline};"

    if String.length(inline_line) <= 100 do
      "\n\n" <> inline_line
    else
      "\n\nexport type #{union_name} =\n  | " <> Enum.join(rendered_arms, "\n  | ") <> ";"
    end
  end

  defp user_declared_union?(typedefs) do
    Enum.any?(typedefs, fn {_, ast, _} ->
      case ast do
        {:type, _, :union, members} ->
          # Atom-only unions (`:a | :b`) don't count — they're not
          # discriminator surfaces, they're enums. A union with at
          # least one map literal or one user_type reference IS a
          # discriminator surface; skip auto-emission so source
          # owns the surface.
          Enum.any?(members, &discriminator_union_arm?/1)

        _ ->
          false
      end
    end)
  end

  defp discriminator_union_arm?({:type, _, :map, _}), do: true
  defp discriminator_union_arm?({:user_type, _, _, _}), do: true
  defp discriminator_union_arm?({:remote_type, _, _}), do: true
  defp discriminator_union_arm?(_), do: false

  defp extract_literal_kind({:type, _, :map, fields}) do
    Enum.find_value(fields, :error, fn
      {:type, _, :map_field_exact, [{:atom, _, :kind}, {:atom, _, literal}]}
      when literal not in [nil, true, false] ->
        {:ok, literal}

      _ ->
        nil
    end)
  end

  defp extract_literal_kind(_), do: :error

  defp mod_to_event_union_name(mod) do
    short = mod |> Module.split() |> tl() |> hd()
    "Wire#{short}Event"
  end

  ## ----- Test seams --------------------------------------------------------

  @doc false
  @spec render_module_for_test(module()) :: String.t()
  def render_module_for_test(mod), do: render_module(mod)

  @doc false
  @spec generate_for_test([module()]) :: String.t()
  def generate_for_test(mods) do
    mods
    |> Enum.sort_by(&inspect/1)
    |> Enum.map(&render_module/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.join("\n\n")
  end

  @doc false
  @spec compare_committed(String.t(), Path.t()) :: :ok | :drift
  def compare_committed(generated, path) do
    case File.read(path) do
      {:ok, committed} when committed == generated -> :ok
      _ -> :drift
    end
  end
end
