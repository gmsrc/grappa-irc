defmodule Grappa.Repo.Migrations.AddProfileFieldsToNetworkCredentials do
  use Ecto.Migration

  # KVIrc-style CTCP USERINFO profile, per (subject, network) like every
  # other identity field on this table: free text (age/location/
  # languages/custom) plus `profile_gender`, a closed-set `Ecto.Enum`
  # stored as plain `:string` (same shape as `auth_method`/
  # `connection_state` on this same table). All nilable, no default —
  # `NULL` across the board means "no profile configured," which is
  # every existing row's honest state.
  def change do
    alter table(:network_credentials) do
      add :profile_age, :string, null: true
      add :profile_gender, :string, null: true
      add :profile_location, :string, null: true
      add :profile_languages, :string, null: true
      add :profile_custom, :string, null: true
    end
  end
end
