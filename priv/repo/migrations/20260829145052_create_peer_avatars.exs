defmodule Grappa.Repo.Migrations.CreatePeerAvatars do
  use Ecto.Migration

  # M3b — bouncer-wide cache of a PEER's fetched CTCP AVATAR image, keyed
  # by (network, folded nick), deliberately a SEPARATE table from
  # `uploads`: a subject-owned permanent upload and a best-effort cache of
  # a stranger's fetched image are different trust domains (CLAUDE.md:
  # a shared data model with a type flag across two trust domains is a
  # boundary violation, not reuse). `nick_key` follows the same fold as
  # every other nick-keyed table (`Identifier.canonical_target/1`) — see
  # CLAUDE.md's nick-key invariant. `expires_at` is NOT NULL here (unlike
  # `uploads.expires_at`, which is nullable/permanent-by-default): every
  # row in this table is a speculative, stale-tolerant preview, never a
  # permanent asset — see docs/DESIGN_NOTES.md #1280 and the M3b entry.
  def change do
    create table(:peer_avatars, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :network_id, references(:networks, on_delete: :delete_all), null: false
      add :nick_key, :string, null: false
      add :slug, :string, null: false
      add :mime, :string, null: false
      add :bytes, :integer, null: false
      add :expires_at, :utc_datetime_usec, null: false

      timestamps(type: :utc_datetime_usec)
    end

    # One cached avatar per (network, peer) — a fresh fetch REPLACES the
    # row (see `Grappa.Avatars.fetch_and_cache/3`), it never accumulates
    # history.
    create unique_index(:peer_avatars, [:network_id, :nick_key])
    create unique_index(:peer_avatars, [:slug])
    create index(:peer_avatars, [:expires_at])
  end
end
