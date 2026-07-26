defmodule Grappa.Repo.Migrations.AddUploadsUserIdCascadeFkIndex do
  @moduledoc """
  Add the missing `uploads.user_id` cascade-FK index (#380 — id-twin of
  #379's `uploads.visitor_id`).

  `uploads` is an `ON DELETE CASCADE` child of BOTH `users` and `visitors`
  (the #211 XOR-FK visitor-parity shape). #379 (P0) added the `visitor_id`
  index — the proven hot path, driven by the 60s `Visitors.Reaper` — but
  its `user_id` sibling is the identical bug class: an unindexed
  `ON DELETE CASCADE` child column, so deleting a user full-scans
  `uploads` to enforce the FK (`EXPLAIN → SCAN uploads`). It only bites
  the rare manual user-delete admin op (not the periodic sweep), so it was
  deliberately scoped OUT of the #379 P0 to keep it minimal; this is the
  one-line completion of the root-cause class ("fix root causes, not
  examples"). See DESIGN_NOTES 2026-07-26.

  Plain `create` (drift should fail loudly per CLAUDE.md); reversible via
  `up`/`down`. Deploy class: **COLD** — a new `priv/repo/migrations/*`
  file is Class 5 in `Grappa.Deploy.Preflight` (the hot path skips
  `mix ecto.migrate`, so `--force-hot` past this would silently NOT build
  the index). The `CREATE INDEX` DDL is itself online-safe for the running
  old code (expand-class — no schema-shape change) and `uploads` is small
  today, so the build is cheap.
  """
  use Ecto.Migration

  def up do
    create index(:uploads, [:user_id])
  end

  def down do
    drop index(:uploads, [:user_id])
  end
end
