defmodule Grappa.Repo.Migrations.AddNickservPassToNetworkCredentials do
  use Ecto.Migration

  # GH #509 — a dedicated `$nickserv_pass` secret on the credential, sibling to
  # `oper_pass_encrypted` (#189), encrypted at rest (Cloak AES-GCM via
  # `Grappa.EncryptedBinary` → BLOB column, same shape as `password_encrypted`).
  #
  # WHY a separate column instead of reusing `password`: on a network where the
  # single `password` field is already spent on `PASS` (server-password /
  # hostmasking), there was nowhere to store the NickServ password, so
  # `$nickserv_pass` in the on-connect perform list expanded to "" and the
  # IDENTIFY reached the wire with no argument. Decoupling the secret from
  # `auth_method` fixes that — the variable now binds from THIS field first,
  # falling back to the `:nickserv_identify` `pending_password` when unset.
  #
  # Cold deploy — one new nullable column, no backfill (existing rows read
  # `nil` == "no separate NickServ password configured", so the fallback to the
  # `:nickserv_identify` upstream password keeps every current setup working).
  def change do
    alter table(:network_credentials) do
      add :nickserv_pass_encrypted, :binary
    end
  end
end
