defmodule Grappa.Avatars.PeerAvatar do
  @moduledoc """
  Schema for the `peer_avatars` table — one row per (network, folded
  peer nick), the bouncer-wide cache of a peer's fetched CTCP AVATAR
  image (M3b).

  Deliberately separate from `Grappa.Uploads.Upload`: a subject-owned
  permanent upload and a best-effort cache of an untrusted stranger's
  fetched image are different trust domains, even though the on-disk
  mechanics (slug filename, storage root) are similar — see
  `Grappa.Avatars` moduledoc.

  `nick_key` is ALWAYS the folded form (`Grappa.IRC.Identifier.
  canonical_target/1`) — the same nick-key invariant every other
  nick-keyed table in this codebase follows. `expires_at` is required
  (unlike `Uploads.Upload`'s nullable/permanent-by-default column):
  every row here is a speculative, stale-tolerant preview.
  """
  use Ecto.Schema
  import Ecto.Changeset

  # Deliberately a PLAIN `field :network_id, :integer`, not a
  # `belongs_to :network, Grappa.Networks.Network` association: this
  # module is a dependency of `Grappa.Session` (`EventRouter` calls
  # `fetch_and_cache/3`), and `Grappa.Networks` already depends on
  # `Grappa.Session` — an association here would need a `Grappa.Networks`
  # Boundary dep and close `Networks → Session → Avatars → Networks`. The
  # DB-level FK (`references(:networks, ...)` in the migration) still
  # enforces referential integrity; nothing here ever needs to preload or
  # pattern-match a `%Network{}`.
  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          network_id: integer() | nil,
          nick_key: String.t() | nil,
          slug: String.t() | nil,
          mime: String.t() | nil,
          bytes: non_neg_integer() | nil,
          expires_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}

  schema "peer_avatars" do
    field :network_id, :integer
    field :nick_key, :string
    field :slug, :string
    field :mime, :string
    field :bytes, :integer
    field :expires_at, :utc_datetime_usec

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Insert-time changeset. `upsert_changeset/2` is the write path
  `Grappa.Avatars.fetch_and_cache/3` actually uses (an `on_conflict`
  REPLACE keyed on the `(network_id, nick_key)` unique index) — this one
  backs that upsert's `%PeerAvatar{}` template.
  """
  @spec insert_changeset(t(), map()) :: Ecto.Changeset.t()
  def insert_changeset(peer_avatar, attrs) do
    peer_avatar
    |> cast(attrs, [:network_id, :nick_key, :slug, :mime, :bytes, :expires_at])
    |> validate_required([:network_id, :nick_key, :slug, :mime, :bytes, :expires_at])
    |> validate_number(:bytes, greater_than: 0)
    |> unique_constraint([:network_id, :nick_key])
    |> unique_constraint(:slug)
  end
end
