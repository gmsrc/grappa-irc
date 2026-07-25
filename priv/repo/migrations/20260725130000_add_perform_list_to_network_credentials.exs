defmodule Grappa.Repo.Migrations.AddPerformListToNetworkCredentials do
  use Ecto.Migration

  # GH #189 — the on-connect perform list + its `$oper_pass` secret, both
  # encrypted at rest (Cloak AES-GCM via `Grappa.EncryptedBinary`, which
  # maps to a BLOB column, same shape as `password_encrypted`). Storing the
  # command list encrypted is load-bearing: a user may paste a literal
  # `/oper vjt <pass>` into the panel, so the column IS a secret — cleartext
  # in sqlite would contradict the standing "credentials encrypted at rest"
  # rule. `$oper_pass` is the sibling variable field so the secret never
  # enters the command text at all.
  #
  # Cold deploy — two new nullable columns, no backfill (existing rows read
  # `nil` == "no perform list configured").
  def change do
    alter table(:network_credentials) do
      add :perform_list_encrypted, :binary
      add :oper_pass_encrypted, :binary
    end
  end
end
