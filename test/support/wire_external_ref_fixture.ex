defmodule Grappa.WireExternalRefFixture do
  @moduledoc """
  Fixture for the gen_wire_types external-type guard test. Not used in
  production.

  Mirrors `Grappa.Themes.BuiltinBackgrounds`: a module OUTSIDE the wire
  glob whose public type references a SAME-MODULE `user_type`. The
  external renderer works one alias at a time and keeps no sibling
  registry, so it cannot resolve `variant()` — and must say so by name
  rather than invent an identifier nothing declares.
  """

  @type variant :: :light | :dark

  @type t :: %{
          key: String.t(),
          variant: variant()
        }
end
