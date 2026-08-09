defmodule GrappaWeb.Admin.SubjectLabels do
  @moduledoc """
  ONE batched `subject → human display name` resolver for the admin
  listings (#1140).

  ## Why it lives at the web layer

  Resolving a subject label crosses BOTH subject contexts — `Accounts`
  for a user's account name, `Networks.Credentials` for a visitor's
  per-network nick. Neither owns the other, and the listing contexts
  (`Grappa.LiveIntrospection`, `Grappa.Vhosts`) deliberately exclude those
  deps. The composition therefore belongs where every admin listing
  already meets: the web edge. Promoted from
  `GrappaWeb.Admin.SessionsController`'s private `resolve_label/3` when
  `/admin/vhosts` needed the same join (#1140 — the grants table printed
  the raw subject UUID).

  ## Cost

  Two queries, one per subject kind, whatever the subject count — the
  batched `Accounts.get_users_by_ids/1` +
  `Credentials.representative_nicks_by_visitor_ids/1`. A kind with no
  subjects issues no query at all. Never a per-row lookup: an admin
  listing is exactly where an N+1 hides.

  ## Missing is missing

  A subject that resolves to no name is ABSENT from the returned map, so
  the caller renders `nil` — the honesty signal the admin surface already
  uses for "the DB row isn't there" (`subject_label: null` on
  `/admin/sessions`, `live_state: null` on `/admin/visitors`). Reachable:
  a live pid whose user row was deleted, and a visitor holding no
  credential yet (`Credentials.list_visitor_credentials/1` documents that
  shape). We never fabricate a placeholder name — the caller still has
  the stable `subject_id` to fall back on.

  ## The visitor label is the representative nick

  A visitor is multi-network and carries one nick per credential. The
  label is the representative (lowest-`network_id`) nick — the same
  identity anchor `Credentials.representative_visitor_credential/1`
  returns, and the same one `/admin/sessions` shows. It is a display
  label, never a key: `subject_id` stays on the wire for that.
  """

  alias Grappa.{Accounts, Subject}
  alias Grappa.Accounts.User
  alias Grappa.Networks.Credentials

  @doc """
  Resolves `subjects` to their display names, keyed by the subject tuple.

  Duplicate subjects collapse; unresolvable subjects are omitted. Two
  batched queries at most (one per subject kind present).
  """
  @spec resolve([Subject.t()]) :: %{Subject.t() => String.t()}
  def resolve(subjects) when is_list(subjects) do
    {user_ids, visitor_ids} = partition_ids(subjects)

    user_labels =
      user_ids
      |> Accounts.get_users_by_ids()
      |> Map.new(fn {id, %User{name: name}} -> {{:user, id}, name} end)

    visitor_ids
    |> Credentials.representative_nicks_by_visitor_ids()
    |> Map.new(fn {id, nick} -> {{:visitor, id}, nick} end)
    |> Map.merge(user_labels)
  end

  # Split into per-kind id lists so each batched lookup gets only the ids
  # its column can match. No dedup: a subject holding N grants / N live
  # sessions repeats here, and passing the dups to an `id IN ^ids` query
  # is harmless (the DB returns one row per id, and the keyed Map.new
  # collapses them) — same call as `SessionsController.partition_subject_ids/1`.
  @spec partition_ids([Subject.t()]) :: {[Ecto.UUID.t()], [Ecto.UUID.t()]}
  defp partition_ids(subjects) do
    Enum.reduce(subjects, {[], []}, fn
      {:user, id}, {users, visitors} -> {[id | users], visitors}
      {:visitor, id}, {users, visitors} -> {users, [id | visitors]}
    end)
  end
end
