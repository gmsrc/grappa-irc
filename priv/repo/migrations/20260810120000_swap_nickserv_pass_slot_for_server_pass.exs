defmodule Grappa.Repo.Migrations.SwapNickservPassSlotForServerPass do
  @moduledoc """
  GH #1044 — retire `network_credentials.nickserv_pass_encrypted` for good and
  open an empty `server_pass_encrypted` in its place.

  ## Why a DROP + ADD and not a RENAME

  A rename would be shorter and would carry the old bytes across. That is
  exactly what must NOT happen: every value still in that column is a
  *NickServ* secret (#509 gave the column that meaning; #124 retired it), and
  the new column holds the server `PASS`. Renaming would relabel a NickServ
  password as a server password on any database that still carries one — a
  wrong secret sent as the `PASS` wire token, which fails the handshake
  outright rather than degrading.

  So the old content is destroyed DELIBERATELY, and the new slot starts empty.

  ## What was measured, and what was not

  On the production node the column is empty: the last row carrying it was
  cleared by hand on 2026-08-10 (#1028), and zero rows in the whole database
  still hold a value. There is nothing to preserve THERE.

  Self-hosted databases have NOT been measured and may still hold values.
  Nothing has read the column since #124, so that content is dead by ruling
  rather than by measurement — the drop is still a deliberate deletion of it
  and the release note says so. Operators who want the bytes keep the
  pre-deploy backup the cold-window gate already requires
  (`docs/OPERATIONS.md`, "Pre-deploy gate").

  ## Why the direction is this way round

  `password_encrypted` KEEPS the NickServ meaning. On every visitor row it IS
  the NickServ secret — a visitor's `auth_method` is derived from its presence
  (`Grappa.Visitors.SessionPlan`) and never reaches `:server_pass` — so
  renaming that column instead would make the name lie on the whole visitor
  population.

  ## COLD

  A `DROP COLUMN` is CONTRACT: old code loading the schema after the column is
  gone crashes, so this cannot ride a hot deploy. `Preflight` classifies it
  cold by construction (`remove` is not a hot alter op).

  `down/0` restores the SHAPE, not the data: the dropped values are gone and
  no rollback can reconstruct them. Recovery is restore-from-backup.
  """
  use Ecto.Migration

  def up do
    alter table(:network_credentials) do
      remove :nickserv_pass_encrypted
      add :server_pass_encrypted, :binary
    end
  end

  def down do
    alter table(:network_credentials) do
      remove :server_pass_encrypted
      add :nickserv_pass_encrypted, :binary
    end
  end
end
