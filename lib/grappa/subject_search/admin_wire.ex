defmodule Grappa.SubjectSearch.AdminWire do
  @moduledoc """
  Operator-facing JSON wire shape for the #257 subject-search autocomplete.
  Sibling of `Grappa.Vhosts.AdminWire`; explicit per-field projection (no
  wildcard `Map.take/2`) so a future field is a deliberate edit here.

  The closed-set `:type` atom rides the wire as the atom itself — Jason
  serializes it to `"user"` / `"visitor"`, matching the vhost-grant
  body's `subject_type` 1:1. Typing it as the atom union (rather than
  stringifying eagerly into a `String.t()` field) is what lets the
  generated TS mirror narrow to a literal union (#448); cic mirrors the
  tag, it originates no state.
  """
  alias Grappa.SubjectSearch.Result

  @type result_json :: %{
          type: :user | :visitor,
          id: String.t(),
          network: String.t() | nil,
          nick: String.t()
        }

  @doc "Renders a search `Result` to the admin JSON shape."
  @spec result_to_admin_json(Result.t()) :: result_json()
  def result_to_admin_json(%Result{type: type, id: id, network: network, nick: nick})
      when type in [:user, :visitor] do
    %{type: type, id: id, network: network, nick: nick}
  end
end
