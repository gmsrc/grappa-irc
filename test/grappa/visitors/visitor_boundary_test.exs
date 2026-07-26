defmodule Grappa.Visitors.VisitorBoundaryTest do
  use ExUnit.Case, async: true

  # #415 — the visitor IDENTITY schema is its OWN leaf boundary, carved out
  # of the `Grappa.Visitors` orchestration boundary (`top_level?: true`) with
  # NO deps. That carve-out is what lets the dozen contexts referencing
  # `%Visitor{}` in a `belongs_to :visitor` FK (or a `{:visitor, _}` subject
  # type) depend on the schema directly instead of waiving the check with a
  # `dirty_xrefs: [Grappa.Visitors.Visitor]` — a `Grappa.Visitors` dep would
  # close cycles via Accounts/Networks/Themes/Subject.
  #
  # Guarding `deps == []` here keeps the leaf invariant PERMANENT: a future
  # dep added to the schema (a validation that reaches into another context,
  # a default that pulls in a sibling) would silently un-leaf it, drag a
  # context back into the schema's dependency set, and reopen the dirty_xref
  # pressure #415 retired. Mirrors `GrappaWeb.BoundaryTest`'s reading of the
  # compiled `Boundary` attribute — the sanctioned annotation-level
  # architecture assertion, NOT source string-matching.
  test "Grappa.Visitors.Visitor is its own top-level leaf boundary (deps: [])" do
    [%{opts: opts}] = Keyword.fetch!(Grappa.Visitors.Visitor.__info__(:attributes), Boundary)

    assert Keyword.get(opts, :top_level?) == true,
           "expected Grappa.Visitors.Visitor to carve out its own top-level " <>
             "boundary (top_level?: true), got opts: #{inspect(opts)}"

    assert Keyword.get(opts, :deps, []) == [],
           "expected Grappa.Visitors.Visitor to stay a leaf (deps: []) so every " <>
             "context can depend on the identity schema without a cycle, got deps: " <>
             "#{inspect(Keyword.get(opts, :deps, []))}"
  end
end
