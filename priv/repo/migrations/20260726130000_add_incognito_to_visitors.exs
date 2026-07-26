defmodule Grappa.Repo.Migrations.AddIncognitoToVisitors do
  @moduledoc """
  #363 incognito mode — a per-session ephemeral visitor whose account and
  data are deleted when the browser closes, with a server-side ~1h linger
  as the authoritative fallback (the client `beforeunload` is unreliable).

  Adds a plain `incognito` boolean to the `visitors` identity/TTL row. It is
  a session variant, not a new deletion path: the existing
  `Grappa.Visitors.Reaper` + `expires_at` machinery IS the executor. An
  incognito visitor is born with a short linger TTL that the Reaper reconcile
  slides forward only WHILE a browser socket is connected (via
  `Grappa.WSPresence`); the moment the last socket drops, the TTL is no
  longer refreshed and elapses ~1h later, and the ordinary `list_expired/0`
  sweep collects it with the full FK ON DELETE CASCADE wipe — no new
  deletion code.

  Plain `ADD COLUMN` (SQLite native, no writable_schema dance needed — this
  ADDS a column rather than changing an existing one's nullability). The
  `DEFAULT false NOT NULL` backfills every existing row to non-incognito:
  the overwhelming majority of visitors are ordinary 48h sessions.
  """
  use Ecto.Migration

  def change do
    alter table(:visitors) do
      add :incognito, :boolean, default: false, null: false
    end
  end
end
