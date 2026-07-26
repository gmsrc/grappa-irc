defmodule Grappa.WireCycleFixture do
  @moduledoc """
  Fixture for the gen_wire_types cyclic-enum guard test. Not used in
  production. `enum_a` and `enum_b` mutually reference each other, so
  resolving either enum's `as const` array would recurse forever
  without the cycle guard — the codegen must instead raise loudly with
  the type names in the cycle.
  """

  @type enum_a :: :x | enum_b()
  @type enum_b :: :y | enum_a()
end
