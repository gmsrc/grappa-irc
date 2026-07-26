defmodule Mix.Tasks.Grappa.GenWireTypesTest do
  use ExUnit.Case, async: true

  alias Mix.Tasks.Grappa.GenWireTypes

  describe "type mapping" do
    test "renders atom literal as TS string literal" do
      assert GenWireTypes.render_type({:atom, [], [:foo]}) == ~s("foo")
    end

    test "renders atom union as TS string union" do
      ast = {:|, [], [{:atom, [], [:a]}, {:atom, [], [:b]}]}
      assert GenWireTypes.render_type(ast) == ~s("a" | "b")
    end

    test "renders String.t() remote-type as string" do
      assert GenWireTypes.render_type({:remote_type, [], [String, :t]}) == "string"
    end

    test "renders DateTime.t() remote-type as string" do
      assert GenWireTypes.render_type({:remote_type, [], [DateTime, :t]}) == "string"
    end

    test "renders Ecto.UUID.t() remote-type as string" do
      assert GenWireTypes.render_type({:remote_type, [], [Ecto.UUID, :t]}) == "string"
    end

    test "renders integer() as number" do
      assert GenWireTypes.render_type({:integer, [], []}) == "number"
    end

    test "renders non_neg_integer() / pos_integer() as number" do
      assert GenWireTypes.render_type({:non_neg_integer, [], []}) == "number"
      assert GenWireTypes.render_type({:pos_integer, [], []}) == "number"
    end

    test "renders boolean() as boolean" do
      assert GenWireTypes.render_type({:boolean, [], []}) == "boolean"
    end

    test "renders bare atom() as string (Jason serializes atoms as strings)" do
      assert GenWireTypes.render_type({:atom, [], []}) == "string"
    end

    test "renders term() as unknown" do
      assert GenWireTypes.render_type({:term, [], []}) == "unknown"
    end

    test "renders nil literal as null" do
      assert GenWireTypes.render_type(nil) == "null"
    end

    test "renders String.t() | nil as string | null" do
      ast = {:|, [], [{:remote_type, [], [String, :t]}, nil]}
      assert GenWireTypes.render_type(ast) == "string | null"
    end

    test "renders [String.t()] as string[]" do
      assert GenWireTypes.render_type([{:remote_type, [], [String, :t]}]) == "string[]"
    end

    test "renders bare map() as Record<string, unknown>" do
      assert GenWireTypes.render_type({:map, [], []}) == "Record<string, unknown>"
    end

    test "renders user_type reference as camelCased alias name" do
      assert GenWireTypes.render_type({:user_type, [], [:my_payload]}) == "MyPayload"
    end

    test "renders remote_type cross-module reference as ModName + typeName" do
      # e.g. Grappa.Networks.Wire.connection_state_event → NetworksWireConnectionStateEvent
      mod = Grappa.Networks.Wire

      assert GenWireTypes.render_type({:remote_type, [], [mod, :connection_state_event]}) ==
               "NetworksWireConnectionStateEvent"
    end
  end

  describe "fixture module emission" do
    test "renders WireFixture.simple_payload as a typed map" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)
      assert output =~ ~s(export type WireFixtureSimplePayload = {)
      assert output =~ ~s|  kind: "simple";|
      assert output =~ ~s(  id: number;)
      assert output =~ ~s(  name: string;)
      assert output =~ ~s(  maybe_label: string | null;)
    end

    # #411 D6b — a pure atom-union @type is now an ENUM: codegen emits an
    # `as const` runtime array AND derives the type from it via
    # `(typeof ARR)[number]`, so the runtime narrowing Set and the compile-time
    # union share ONE generated source (kills the three-parallel-structures
    # half-migration in friendly*Error.ts). The derived type is structurally
    # identical to the old `"user" | "visitor"` literal union — consumers are
    # unaffected.
    test "renders WireFixture.subject_kind as an as-const array + derived type" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)

      assert output =~
               ~s|export const WIRE_FIXTURE_SUBJECT_KIND = ["user", "visitor"] as const;|

      assert output =~
               ~s|export type WireFixtureSubjectKind = (typeof WIRE_FIXTURE_SUBJECT_KIND)[number];|

      # The OLD bare-literal-union shape must be gone (total consistency).
      refute output =~ ~s|export type WireFixtureSubjectKind = "user" \| "visitor";|
    end

    test "renders WireFixture.collection_payload referencing WireFixtureSubjectKind alias" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)
      assert output =~ ~s(  tags: WireFixtureSubjectKind[];)
    end

    # cross-surface S2 (codebase-review 2026-07-19): `optional(...)` map
    # keys were rendered identically to `required(...)` — the generated
    # type over-claimed an omitted key as always-present, type-lying to
    # any cic code that trusts wireTypes.ts. The server deliberately
    # omits such keys (e.g. Cic.Wire's `version`), so the wire shape is
    # `key?: T`, not `key: T`.
    test "renders optional(...) map key as key?: T, required as key: T" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)
      assert output =~ ~s(export type WireFixtureOptionalFieldPayload = {)
      assert output =~ ~s(  always: string;)
      assert output =~ ~s(  sometimes?: string;)
      refute output =~ ~s(  sometimes: string;)
    end

    # Pins the real production deliverable: Cic.Wire's `version` is
    # `optional(:version) => String.t()`, so the generated
    # CicWireBundleHashPayload must carry `version?: string`.
    test "Cic.Wire bundle_hash renders version as optional" do
      output = GenWireTypes.render_module_for_test(Grappa.Cic.Wire)
      assert output =~ ~s(  version?: string;)
      refute output =~ ~s(  version: string;)
    end

    test "emits discriminated union when 2+ payloads carry literal kind" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)
      # WireFixture has simple_payload + collection_payload, both with kind literals
      # mod_to_event_union_name → tl=[WireFixture], hd=WireFixture → WireWireFixtureEvent
      assert output =~ ~s(export type WireWireFixtureEvent =)
      assert output =~ "WireFixtureSimplePayload"
      assert output =~ "WireFixtureCollectionPayload"
    end
  end

  describe "deterministic ordering" do
    test "modules sorted alphabetically by inspect/1" do
      full = GenWireTypes.generate_for_test([Grappa.WireFixture, Grappa.AdminEvents.Wire])
      {idx_admin, _} = :binary.match(full, "Grappa.AdminEvents.Wire")
      {idx_fixture, _} = :binary.match(full, "Grappa.WireFixture")
      assert idx_admin < idx_fixture
    end
  end

  # #411 D6b — the enum→array rule generalized to recursively-enum unions:
  # every member is an atom literal (≠ nil/true/false) OR a same-module
  # user_type ref to another enum, and the array SPREADS the referenced
  # enum's array — mirroring the Elixir `shared | specific` composition in
  # GrappaWeb.ErrorTokens. This is the codegen source #411 widens the glob
  # to reach.
  describe "recursively-enum arrays (GrappaWeb.ErrorTokens)" do
    test "the widened glob reaches GrappaWeb.ErrorTokens in a full generate/0 run" do
      full = GenWireTypes.generate()
      assert full =~ "// === GrappaWeb.ErrorTokens ==="
    end

    # Substring asserts (robust to biome's inline-vs-multiline wrapping at
    # lineWidth 100 — a long array wraps one-element-per-line; the separate
    # `bun run check` biome gate pins the exact whitespace).
    test "a pure atom-union member type emits its array + derived type" do
      output = GenWireTypes.render_module_for_test(GrappaWeb.ErrorTokens)

      assert output =~ ~s|export const ERROR_TOKENS_SHARED_ERROR_TOKEN = [|
      assert output =~ ~s|"not_found"|
      assert output =~ ~s|"body_too_large"|

      assert output =~
               ~s|export type ErrorTokensSharedErrorToken = (typeof ERROR_TOKENS_SHARED_ERROR_TOKEN)[number];|
    end

    test "a composing enum SPREADS the referenced enum array, not inlined" do
      output = GenWireTypes.render_module_for_test(GrappaWeb.ErrorTokens)

      # rest_error_token leads with `shared_error_token` then its own atoms,
      # so the array SPREADS the SHARED const rather than re-inlining its
      # tokens (DRY composition, mirroring the Elixir `shared | specific`).
      assert output =~ ~s|export const ERROR_TOKENS_REST_ERROR_TOKEN = [|
      assert output =~ ~s|...ERROR_TOKENS_SHARED_ERROR_TOKEN|
      assert output =~ ~s|"bad_request"|

      assert output =~
               ~s|export type ErrorTokensRestErrorToken = (typeof ERROR_TOKENS_REST_ERROR_TOKEN)[number];|

      # channel_error_token composes the same way.
      assert output =~ ~s|export const ERROR_TOKENS_CHANNEL_ERROR_TOKEN = [|
      assert output =~ ~s|"unknown_topic"|

      # A shared token appears ONCE (in the SHARED const), never duplicated
      # into the composing arrays — proves spread, not inline.
      shared_occurrences =
        output |> String.split(~s|"not_found"|) |> length() |> Kernel.-(1)

      assert shared_occurrences == 1
    end

    test "the SHARED const is emitted before the REST const that spreads it" do
      output = GenWireTypes.render_module_for_test(GrappaWeb.ErrorTokens)
      {idx_shared, _} = :binary.match(output, "export const ERROR_TOKENS_SHARED_ERROR_TOKEN")
      {idx_rest, _} = :binary.match(output, "export const ERROR_TOKENS_REST_ERROR_TOKEN")
      assert idx_shared < idx_rest
    end

    test "a cyclic enum reference raises loudly with the type names in the cycle" do
      err =
        assert_raise RuntimeError, fn ->
          GenWireTypes.render_module_for_test(Grappa.WireCycleFixture)
        end

      assert err.message =~ "cyclic enum reference"
      assert err.message =~ "enum_a"
      assert err.message =~ "enum_b"
    end
  end

  describe "--check exit code helper" do
    test "compare_committed/2 returns :ok when committed file matches generated" do
      tmp = Path.join(System.tmp_dir!(), "wireTypes.ts.gentest")
      File.write!(tmp, "// content\n")
      assert GenWireTypes.compare_committed("// content\n", tmp) == :ok
    end

    test "compare_committed/2 returns :drift when content differs" do
      tmp = Path.join(System.tmp_dir!(), "wireTypes.ts.gentest.drift")
      File.write!(tmp, "// stale content\n")
      assert GenWireTypes.compare_committed("// fresh content\n", tmp) == :drift
    end

    test "compare_committed/2 returns :drift when file is missing" do
      tmp = Path.join(System.tmp_dir!(), "wireTypes.ts.gentest.missing-#{System.unique_integer()}")
      _ = File.rm(tmp)
      assert GenWireTypes.compare_committed("// any\n", tmp) == :drift
    end
  end
end
