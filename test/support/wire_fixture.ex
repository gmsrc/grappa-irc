defmodule Grappa.WireFixture do
  @moduledoc "Fixture for gen_wire_types codegen tests. Not used in production."

  @type subject_kind :: :user | :visitor

  @type simple_payload :: %{
          kind: :simple,
          id: integer(),
          name: String.t(),
          maybe_label: String.t() | nil
        }

  @type collection_payload :: %{
          kind: :collection,
          items: [String.t()],
          tags: [subject_kind()]
        }

  # Exercises the codegen's `optional(...)` handling: a server-omitted
  # key must render `key?: T`, not `key: T` (which over-claims the field
  # as always present). See gen_wire_types cross-surface S2.
  @type optional_field_payload :: %{
          required(:always) => String.t(),
          optional(:sometimes) => String.t()
        }

  # X-S4 (#1406) — a map whose ONE association is keyed by a UNION of atom
  # literals. This is the allowlisted-metadata-bag shape that
  # `Grappa.Scrollback.Meta.t/0` uses, and the one map form the codegen
  # could not express: `atom_keyed_field?/1` matches a SINGLE atom key, so
  # a union key fell to the open-map branch and rendered
  # `Record<string, unknown>` — the key names dropped, and unlike bare
  # `map()` without even a warning to say they had been.
  @type union_keyed_payload :: %{
          optional(:alpha | :beta) => term()
        }

  # The residual shape the codegen still cannot express: a union-keyed
  # association MIXED with a named key. It stays an open map on purpose,
  # but it must not stay SILENT about it.
  @type mixed_key_payload :: %{
          required(:named) => String.t(),
          optional(:alpha | :beta) => term()
        }
end
