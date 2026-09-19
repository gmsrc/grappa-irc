defmodule Grappa.Repo.Migrations.AddDetachedAtToNetworkCredentials do
  @moduledoc """
  Issue 2219 — the reversible half of "get this network off my session".

  A user could accrete a network (`POST /session/networks`) and never take
  it back: the rail hides a parked network since #1985, but `$home` keeps
  listing it and the credential keeps its nick, SASL user, server/oper
  secrets, perform list and autojoin. The accretion verb had no inverse.

  `detached_at` is that inverse, and it is a SEPARATE AXIS from
  `connection_state` on purpose. The four states describe the upstream
  LINK (`:connected | :parked | :failing | :failed`, #1675); this column
  describes whether the subject is still asking to hold the binding at
  all. Folding it in as a fifth state would put a visibility fact into a
  link-state machine that `connect/1`, `disconnect/2`, `mark_failed/2`,
  `mark_failing/2` and `mark_registered/1` all pattern-match on — the
  "shared data model with a type flag" boundary violation CLAUDE.md names.

  Nullable, no default, no backfill: every existing row is attached, which
  is exactly what `NULL` means here. No index — the reads that filter it
  already carry a `user_id` (or `(user_id, network_id)`) equality that the
  existing unique index serves, and a partial index on a column that is
  NULL for all but a handful of rows buys nothing at this scale.
  """
  use Ecto.Migration

  def change do
    alter table(:network_credentials) do
      add :detached_at, :utc_datetime
    end
  end
end
