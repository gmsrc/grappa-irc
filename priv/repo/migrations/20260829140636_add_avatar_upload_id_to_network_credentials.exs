defmodule Grappa.Repo.Migrations.AddAvatarUploadIdToNetworkCredentials do
  use Ecto.Migration

  # M3a — the per-(subject, network) avatar. Nilable FK to a PERMANENT
  # `uploads` row (`expires_at: nil`, unlike the ephemeral scrollback-image
  # uploads) so `Grappa.Uploads.Reaper`'s TTL sweep never touches it — only
  # `Credentials.set_avatar/4`/`clear_avatar/1` retire an avatar row, on
  # replace or explicit removal. `on_delete: :nilify_all`: if an avatar
  # upload is ever hard-deleted out from under a credential (test-support
  # `Uploads.delete_all_for_user/1`, a future admin hard-purge), the
  # credential just loses its avatar rather than the FK dangling or the
  # credential row itself being dragged down.
  def change do
    alter table(:network_credentials) do
      add :avatar_upload_id, references(:uploads, type: :binary_id, on_delete: :nilify_all)
    end

    create index(:network_credentials, [:avatar_upload_id])
  end
end
