defmodule Grappa.Repo.Migrations.AddClientTokensToSessions do
  use Ecto.Migration

  # GH #1196 — a per-client token is a `sessions` row with a different
  # lifecycle (no idle expiry) and a restricted authorization scope. Two
  # columns carry that difference.
  #
  # `kind` is the discriminator and is deliberately NOT derived from
  # `label IS NOT NULL`: the scope + lifecycle rules must hang off a field
  # that MEANS "restricted, non-expiring", not off the nullness of a
  # display string. A later feature that labels web sessions ("Chrome on
  # Mac") would otherwise flip the security boundary silently.
  #
  # Default `"web"` backfills every existing row to today's behaviour, so
  # there is no data migration. Expand-only, which is why
  # `Grappa.Deploy.Preflight` classifies it HOT: Ecto selects named
  # columns, so a node still running the old `Session` module cannot see
  # the two new ones, and the reload brings the schema and the column
  # into agreement in either order.
  def change do
    alter table(:sessions) do
      add :kind, :string, null: false, default: "web"
      add :label, :string, null: true
    end

    # The device list is `WHERE user_id = ? AND kind = 'client'`. The
    # existing `[:user_id]` index already narrows to a handful of rows,
    # but the composite keeps the list a pure index read as a long-lived
    # account accumulates web sessions around its few client tokens.
    create index(:sessions, [:user_id, :kind])
  end
end
