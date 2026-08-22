defmodule Grappa.Repo.Migrations.WidenBootCredentialIndexToFailing do
  @moduledoc """
  #1675 — the boot query stopped being "WHERE connection_state =
  'connected'".

  `Credentials.list_credentials_for_all_users/0` now selects the
  WANTED-UP set, `IN ('connected','failing')`, so a reboot inside a
  reconnect-backoff window brings the network back instead of leaving it
  down until a human PATCHes the row. The partial index added by
  `20260512083037` (and carried through the `20260711123000` XOR-FK
  table rebuild) is predicated on the old equality, and SQLite may only
  use a partial index when the query's WHERE clause IMPLIES the index's
  own — which `IN ('connected','failing')` does not. Left alone, the
  index would carry a predicate its own query can never match while
  still costing a write on every transition.

  ## What this does NOT claim, measured rather than assumed

  `EXPLAIN QUERY PLAN` on the boot query (test DB, 2026-08-22) picks
  `network_credentials_user_id_network_id_index (user_id>?)` — the
  partial unique index that also serves the `user_id IS NOT NULL`
  conjunct #211 added — and not this one, before or after the widening.
  So this is NOT "restoring the index the boot path needs": it keeps the
  predicate ALIGNED with the query the index was created for. One
  observation, on a small DB with no `ANALYZE` stats, and SQLite's
  choice is per-connection — enough to refuse the stronger claim, not
  enough to justify dropping the index outright.

  No data migration: this is an index predicate, not a value. Rows keep
  whatever state they carry (no existing row can be `:failing` — the
  value did not exist before this deploy).
  """
  use Ecto.Migration

  @old_name :network_credentials_connection_state_connected_index
  @new_name :network_credentials_connection_state_boot_index
  @boot_predicate "connection_state IN ('connected', 'failing')"

  def up do
    drop index(:network_credentials, [:connection_state],
            where: "connection_state = 'connected'",
            name: @old_name
          )

    create index(:network_credentials, [:connection_state],
             where: @boot_predicate,
             name: @new_name
           )
  end

  def down do
    drop index(:network_credentials, [:connection_state],
            where: @boot_predicate,
            name: @new_name
          )

    create index(:network_credentials, [:connection_state],
             where: "connection_state = 'connected'",
             name: @old_name
           )
  end
end
