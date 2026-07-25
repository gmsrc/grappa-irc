defmodule Grappa.Repo.Migrations.AddMessages393PerfCoveringIndexes do
  @moduledoc """
  #393 — restore sargability of the two `messages` read shapes that
  saturated the SQLite pool under real load (slow logon, /motd, send).

  Fresh 25s prod telemetry (2026-07-25): 19120ms of DB time, top consumers
  a `SELECT` scrollback fetch (409ms mean, n=24) and the `count_after_split`
  DM shape (432ms mean, n=6) — BOTH the non-sargable folded DM-peer
  predicate. This migration ships two covering-index families, one per
  read shape. Both are index-only (no schema-shape change, no data rewrite).

  ## (A) Channel unread-count covering index — kind at the tail

  `Scrollback.count_after_split/5` for a CHANNEL window is a GROUP BY
  aggregate with NO LIMIT over `(subject, network_id, channel, id > cursor)`,
  reading `kind` for every post-cursor row. The `(subject, network_id,
  channel, id)` composite (20260722202612) covered the RANGE but not
  `kind`, so the aggregate did one table row-fetch per post-cursor row +
  a TEMP B-TREE (prod: 80ms/79ms over 11066 rows on `#linux`). Appending
  `kind` at the index tail makes the aggregate a COVERING scan — no table
  touch (prod: 5-7ms, ~15x). The new index shares the OLD one's
  `(subject, network_id, channel, id)` prefix, so the two
  `..._channel_id_index` composites are DROPped here: write-amplification
  returns to exactly what it was.

  ## (B) DM read/count covering index — folded `COALESCE(dm_with, channel)`

  The DM-peer window match (`Scrollback.where_dm_peer/2`, shared by the
  read path `channel_or_dm_where/3` + the delete path `delete_for_dm/3`)
  folds the peer key (#372: `dm_with` is stored case-PRESERVED for display,
  matched folded). The prior two-arm disjunction
  `fold(dm_with) = ? OR (dm_with IS NULL AND fold(channel) = ?)` was
  NON-sargable: even with per-arm folded expression indexes the planner
  stayed on `messages_network_id_index` and folded row-by-row over the
  whole network's history (measured — index alone had NO effect). #393
  collapses the OR to the equivalent single folded-COALESCE equality
  `fold(COALESCE(dm_with, channel)) = ?` (vjt proved equivalence on a prod
  copy via `EXCEPT` over network 3: ZERO id mismatches). That single
  predicate SEEKs this expression index — prod `EXPLAIN` flipped from
  `SEARCH USING messages_network_id_index` to
  `SEARCH USING COVERING INDEX ... (subject=? AND network_id=? AND
  <expr>=? AND id>?)`, 204ms → 0.000s. `kind` at the tail makes the count
  aggregate covering (as in (A)); `id` keeps the `id > cursor` reads
  (`fetch_after/6`, `unread_content_tail/6`, `count_after*`) seekable on
  the folded value. The `COALESCE(dm_with, channel)` fold expression is
  the SAME one `list_archive/3`'s GROUP BY already uses (in-house
  precedent) and is byte-identical to `Identifier.nick_fold_sql/1` applied
  to the COALESCE — the `IdentifierTest` pin test + the scrollback DDL
  byte-identity test guard the literal against drift (one-byte drift =
  silent index loss).

  ## `create_if_not_exists` — reconciliation of live-applied prod indexes

  Normally grappa uses plain `create` so a schema/migration drift is a
  loud error (CLAUDE.md). This migration is the documented exception:
  every index here is applied LIVE on prod ahead of the formal cold
  deploy, because it fixes a prod incident in progress —
    * (A) both channel covering indexes: applied 2026-07-25 07:52 UTC
      (`CREATE INDEX IF NOT EXISTS` over 654k rows, 1.6-2.0s each);
    * (B) both DM covering indexes: applied 2026-07-25 08:26 UTC (2.442s /
      2.570s over 654k rows, verified in `sqlite_master`). The ship half
      that REMAINS is the CODE — the `where_dm_peer/2` query rewrite; the
      index half is Preflight Class 5 = COLD (the hot path skips `mix
      ecto.migrate`), so applying the DDL live ahead of time is what lets
      the fix land via a code-only HOT deploy: the indexes are already up.
  `create_if_not_exists` makes this migration a no-op on the already-live
  indexes at the next cold deploy rather than aborting on "index already
  exists"; the migration row still records, so no drift. The live DDL is
  byte-identical to what Ecto emits here (NO partial `WHERE` clause — the
  live prod DDL omits it), so the two paths converge. `drop_if_exists`
  mirrors the redundant-index drops.

  ## rfc1459 fold in pure SQL — byte-identity is load-bearing

  The (B) index expression MUST be character-identical to
  `Grappa.IRC.Identifier.nick_fold_sql/1` (ASCII `lower()` + the four
  bracket `replace()`s `[ ] \\ ~` -> `{ } | ^`) applied to
  `COALESCE(dm_with, channel)`, or SQLite silently stops recognising the
  folded query as index-eligible (no error — just the old scan). Inlined
  `defp fold/1` because migrations run BEFORE the app is loaded and cannot
  call into `lib/` (mirrors `20260628100100` / the earlier fold
  migrations); the pin test guards the literal.

  ## Cold deploy

  New migration file — Preflight `migration?/1` (Class 5) forces COLD (the
  hot path skips `mix ecto.migrate`). The `CREATE INDEX` builds are
  online-safe for the running old code (expand-class — no schema-shape
  change), but they share one migration transaction, so schedule off a
  traffic peak. See DESIGN_NOTES 2026-07-25.
  """
  use Ecto.Migration

  # rfc1459 fold of a column expression, pure SQL. Self-contained (no
  # module dep — migrations run under a possibly-truncated code load
  # order). MUST stay character-identical to `Identifier.nick_fold_sql/1`
  # and the other folded-index migrations, or SQLite ignores the index.
  defp fold(col) do
    "replace(replace(replace(replace(lower(#{col}), '[', '{'), ']', '}'), '\\', '|'), '~', '^')"
  end

  def up do
    # (B) DM read/count — folded COALESCE(dm_with, channel), kind at tail
    # for a covering aggregate + id for the cursor reads. Subject-leading
    # so it can never regress to a cross-subject scan. `create_if_not_exists`
    # so the live prod-relief apply (see moduledoc) doesn't abort.
    create_if_not_exists index(
                           :messages,
                           ["user_id", "network_id", fold("COALESCE(dm_with, channel)"), "id", "kind"],
                           name: :messages_user_id_network_id_dm_coalesce_fold_id_kind_index
                         )

    create_if_not_exists index(
                           :messages,
                           ["visitor_id", "network_id", fold("COALESCE(dm_with, channel)"), "id", "kind"],
                           name: :messages_visitor_id_network_id_dm_coalesce_fold_id_kind_index
                         )

    # (A) Channel unread-count covering index — already live on prod
    # 2026-07-25 07:52 UTC; reconciled here.
    create_if_not_exists index(:messages, ["user_id", "network_id", "channel", "id", "kind"],
                           name: :messages_user_id_network_id_channel_id_kind_index
                         )

    create_if_not_exists index(:messages, ["visitor_id", "network_id", "channel", "id", "kind"],
                           name: :messages_visitor_id_network_id_channel_id_kind_index
                         )

    # Drop the now-redundant `(subject, network_id, channel, id)` composites
    # (20260722202612) — a strict prefix of the (A) covering indexes above,
    # so any query they served is served identically by the kind-index
    # prefix. Net write-amplification unchanged.
    drop_if_exists index(:messages, ["user_id", "network_id", "channel", "id"],
                     name: :messages_user_id_network_id_channel_id_index
                   )

    drop_if_exists index(:messages, ["visitor_id", "network_id", "channel", "id"],
                     name: :messages_visitor_id_network_id_channel_id_index
                   )
  end

  def down do
    # Recreate the redundant composites, then drop the (A)+(B) covering
    # indexes. `create_if_not_exists`/`drop_if_exists` for symmetry with the
    # live-reconciliation posture of `up`.
    create_if_not_exists index(:messages, ["user_id", "network_id", "channel", "id"],
                           name: :messages_user_id_network_id_channel_id_index
                         )

    create_if_not_exists index(:messages, ["visitor_id", "network_id", "channel", "id"],
                           name: :messages_visitor_id_network_id_channel_id_index
                         )

    drop_if_exists index(:messages, ["visitor_id", "network_id", "channel", "id", "kind"],
                     name: :messages_visitor_id_network_id_channel_id_kind_index
                   )

    drop_if_exists index(:messages, ["user_id", "network_id", "channel", "id", "kind"],
                     name: :messages_user_id_network_id_channel_id_kind_index
                   )

    drop_if_exists index(
                     :messages,
                     ["visitor_id", "network_id", fold("COALESCE(dm_with, channel)"), "id", "kind"],
                     name: :messages_visitor_id_network_id_dm_coalesce_fold_id_kind_index
                   )

    drop_if_exists index(
                     :messages,
                     ["user_id", "network_id", fold("COALESCE(dm_with, channel)"), "id", "kind"],
                     name: :messages_user_id_network_id_dm_coalesce_fold_id_kind_index
                   )
  end
end
