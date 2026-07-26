defmodule Grappa.Repo.Migrations.AddAwayStateToNetworkCredentials do
  use Ecto.Migration

  # GH #417 — persist the user's EXPLICIT away so it survives a session
  # crash / `:transient` respawn / upstream reconnect. Pre-#417 the away
  # lived only in `Session.Server` GenServer state and vanished silently
  # on restart (the user believed they were away; the server did not).
  #
  # Twin of the `connection_state_reason` / `connection_state_changed_at`
  # pair already on this table: `away_reason` is the `/away :<reason>`
  # string re-emitted upstream on reconnect; `away_since` is the original
  # away-start timestamp, restored verbatim so the mentions-bundle window
  # shown at `/back` spans the honest period (not a reconnect-truncated
  # one). Both nil ⟺ not away. Only `:away_explicit` is persisted —
  # `:away_auto` re-derives from WSPresence on restart and is never
  # written here.
  #
  # `away_since` is `:utc_datetime_usec` (not `:utc_datetime` like
  # `connection_state_changed_at`) so it round-trips `AwayState.started_at`
  # — a `DateTime` stamped with usec precision by `DateTime.utc_now/0` —
  # byte-for-byte.
  #
  # Cold deploy — two new nullable columns, no backfill (existing rows
  # read nil == "not away").
  def change do
    alter table(:network_credentials) do
      add :away_reason, :string
      add :away_since, :utc_datetime_usec
    end
  end
end
