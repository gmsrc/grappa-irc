defmodule Grappa.Repo.Migrations.AddTlsVerifyToNetworkServers do
  @moduledoc """
  #1677 — per-server TLS certificate-verification posture.

  `NOT NULL DEFAULT true` is the whole safety argument: every existing row,
  and every row a caller writes without naming the field, keeps the #89
  `verify: :verify_peer` posture. The opt-out has to be typed out.

  ## Why this is a plain ADD COLUMN and NOT the table-recreate dance

  The issue proposed following the SQLite `CHECK`-constraint recreate pattern
  from `20260504020002_*`. Measured, that would be wrong here, and actively
  destructive.

  The recreate dance exists for ONE reason: SQLite rejects
  `ALTER TABLE ... ADD CONSTRAINT`, so a table that needs a new CHECK must be
  rebuilt around it. `ALTER TABLE ... ADD COLUMN` is supported natively, and a
  `NOT NULL` column with a constant default is exactly the shape SQLite
  accepts. `tls_verify` is a boolean — there is no closed-set enum to mirror
  back into the schema, so there is no CHECK to add and nothing the dance
  would buy.

  The precedent in this table agrees: `source_address`, the last column added
  to `network_servers` (#266, `20260603174206_add_source_address_to_servers`),
  went in with a plain three-line `alter table`.

  And copying `20260504020002_*`'s snippet today would DROP DATA. That
  migration recreated `network_servers` only to refresh its FK ref text
  ("We add no CHECK to it"), so its `CREATE TABLE` is frozen at the
  2026-05-04 column set — which predates `source_address` by a month. Its
  `INSERT INTO ... SELECT` names nine columns and `source_address` is not
  among them: every per-network outbound bind would be silently discarded.
  That is precisely the frozen-snippet hazard the sibling `messages` section
  of that same file warns about in its own moduledoc.

  ## Rollback

  `down/0` drops the column. SQLite has supported `ALTER TABLE DROP COLUMN`
  since 3.35 and the column carries no index or constraint, so no dance is
  needed on the way back either.
  """
  use Ecto.Migration

  def up do
    alter table(:network_servers) do
      add :tls_verify, :boolean, null: false, default: true
    end
  end

  def down do
    alter table(:network_servers) do
      remove :tls_verify
    end
  end
end
