defmodule Grappa.WireFixtureDegraded do
  @moduledoc """
  Fixture for the ONE gen_wire_types case that must WARN. Not used in
  production.

  Kept apart from `Grappa.WireFixture` on purpose: rendering a module
  containing this type emits an `IO.warn`, and every other codegen test
  renders `WireFixture` — so leaving it there printed the warning ten times
  across the suite and buried the one assertion that is about it.
  """

  # X-S4 (#1406) — the residual shape the codegen cannot express: a
  # union-keyed association MIXED with a named key. It degrades to an open
  # map on purpose. It must not degrade SILENTLY.
  @type mixed_key_payload :: %{
          required(:named) => String.t(),
          optional(:alpha | :beta) => term()
        }
end
