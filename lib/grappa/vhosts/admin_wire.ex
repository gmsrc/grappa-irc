defmodule Grappa.Vhosts.AdminWire do
  @moduledoc """
  Operator-facing JSON wire shapes for the #228 vhost admin surface
  (`/admin/vhosts` + grants). Sibling to `Grappa.Networks.AdminWire`;
  explicit per-field projection (no wildcard `Map.take/2`) so a future
  schema field is a deliberate edit here (CLAUDE.md "no leaky
  abstractions").
  """
  alias Grappa.{Subject, Vhosts}
  alias Grappa.Vhosts.{Grant, Vhost}

  @type vhost_json :: %{
          id: integer(),
          address: String.t(),
          in_pool: boolean(),
          generally_available: boolean(),
          inserted_at: DateTime.t(),
          updated_at: DateTime.t()
        }

  @type grant_json :: %{
          id: integer(),
          vhost_id: integer(),
          subject_type: :user | :visitor,
          subject_id: String.t(),
          subject_label: String.t() | nil
        }

  @doc "Renders a vhost row to the admin JSON shape."
  @spec vhost_to_admin_json(Vhost.t()) :: vhost_json()
  def vhost_to_admin_json(%Vhost{} = v) do
    %{
      id: v.id,
      address: v.address,
      in_pool: v.in_pool,
      generally_available: v.generally_available,
      inserted_at: v.inserted_at,
      updated_at: v.updated_at
    }
  end

  @doc """
  Renders a grant row to the admin JSON shape. The subject is projected
  as a `(subject_type, subject_id)` pair (the XOR FK, never both) so the
  wire is subject-polymorphic without leaking which column is NULL.

  `subject_type` carries the **atom**, not an eager string: Jason
  serializes it to the identical wire bytes, and the closed atom union
  is what lets the generated TS mirror be a literal union instead of a
  bare `string` (#448).

  `labels` is the batched `%{subject => name}` map from
  `GrappaWeb.Admin.SubjectLabels.resolve/1`; the grant's own subject pair
  is the lookup key, so a user and a visitor sharing a uuid string can
  never cross. `subject_label: nil` when the subject resolves to no name —
  the honesty signal (#1140). `subject_id` STAYS on the wire: it is the
  stable key, the label is display only.
  """
  @spec grant_to_admin_json(Grant.t(), %{Subject.t() => String.t()}) :: grant_json()
  def grant_to_admin_json(%Grant{} = g, labels) when is_map(labels) do
    {subject_type, subject_id} = subject = Vhosts.grant_subject(g)

    %{
      id: g.id,
      vhost_id: g.vhost_id,
      subject_type: subject_type,
      subject_id: subject_id,
      subject_label: Map.get(labels, subject)
    }
  end
end
