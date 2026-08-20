defmodule Grappa.WireFixtureLongUnion do
  @moduledoc """
  Fixture for the over-100-column line-breaking arm of
  `Mix.Tasks.Grappa.GenWireTypes.format_plain_typedef/2` (#1466). Not used
  in production.

  Kept apart from `Grappa.WireFixture` on purpose, and not for the reason
  `Grappa.WireFixtureDegraded` is: a `@type` that is a union with a MAP arm
  makes `user_declared_union?/1` true for the whole module, which suppresses
  the auto-emitted `Wire<Short>Event` discriminated union. Declaring these
  types next to `simple_payload`/`collection_payload` would therefore delete
  `WireWireFixtureEvent` from the fixture module's output — a fixture that
  silently disables the very feature a sibling test asserts.

  Every type here renders LONGER than 100 columns on one line, so every one
  of them reaches the line-breaking arm. That is the only thing they have in
  common; what differs is whether the AST is a union, which is exactly the
  question the arm used to answer by string-sniffing.
  """

  # NOT a union: a list of allowlisted-metadata bags (the `Scrollback.Meta.t/0`
  # shape, in a list). Renders `Partial<Record<"a" | "b", unknown>>[]` — three
  # characters `" | "` in a body with no top-level union anywhere in it.
  @type nested_partial_list :: [%{optional(:alpha_channel | :beta_channel) => term()}]

  # IS a union, with a nested `" | "` INSIDE its first arm. A generator that
  # gets the classification right and the split wrong still emits broken TS
  # here, so this type separates the two halves of the defect.
  @type nested_partial_or_null :: %{optional(:alpha_channel | :beta_channel) => term()} | nil

  # The regression pin: a plain union of same-module refs, the shape every
  # union that reaches this arm in the real wire actually has
  # (`Grappa.AdminEvents.Wire.event/0`). Its rendering must not move.
  @type long_alias_union :: nested_partial_list() | nested_partial_or_null()
end
