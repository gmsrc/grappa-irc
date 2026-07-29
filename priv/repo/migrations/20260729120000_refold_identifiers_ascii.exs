defmodule Grappa.Repo.Migrations.RefoldIdentifiersAscii do
  @moduledoc """
  #525 — re-fold every LIVE identifier index from rfc1459 to plain ASCII.

  ## Why

  #121/#364 folded nicks AND channels with the **rfc1459** table (`A-Z`
  plus the four "national" chars `[ ] \\ ~` → `{ } | ^`) on the stated
  premise "Azzurra runs bahamut, `CASEMAPPING=rfc1459`". Measured, that
  premise is wrong: Azzurra advertises `CASEMAPPING=ascii` in 005 AND its
  ircd (`src/match.c` `tolowertab[]`) folds ONLY `A-Z`, leaving
  `[ \\ ] ^ ~` untouched. So the stack OVER-folded: two identifiers the
  ircd keeps distinct (`#chan[1]` vs `#chan{1}`, `foo[1]` vs `foo{1}`)
  collapsed onto one grappa key — the #525 window-merge / "ghost in the
  nicklist" bug, reproduced live against prod.

  `Grappa.IRC.Identifier` (the runtime fold) is narrowed to `lower()` in
  the same release; this migration converges the SQL expression indexes
  so the going-forward query fold and the stored index expression agree.

  ## The seven LIVE folded indexes (four tables)

  The issue text listed four migrations, but only two of them host a live
  UNIQUE fold index. The full set of LIVE fold-expression indexes — each
  recreated here from `<rfc1459>` to `lower(...)`, name unchanged:

    * `query_windows_user_network_nick_folded_index`      (UNIQUE, partial)
    * `query_windows_visitor_network_nick_folded_index`   (UNIQUE, partial)
    * `notify_entries_user_network_nick_folded_index`     (UNIQUE, partial) — missed by the issue
    * `notify_entries_visitor_network_nick_folded_index`  (UNIQUE, partial) — missed by the issue
    * `network_credentials_visitor_folded_nick_network_id_index` (UNIQUE, partial)
    * `messages_user_id_network_id_dm_coalesce_fold_id_kind_index`    (#393 covering, non-unique) — missed by the issue
    * `messages_visitor_id_network_id_dm_coalesce_fold_id_kind_index` (#393 covering, non-unique) — missed by the issue

  The compile-time on-conflict `:unsafe_fragment` targets in
  `Grappa.QueryWindows` + `Grappa.Notify` derive from
  `Identifier.nick_fold_sql/1`; once that renders `lower(...)` the index
  MUST match or the first contended upsert throws "ON CONFLICT clause
  does not match". The #393 covering indexes are the sargable DM
  read/count path — refolding the `COALESCE(dm_with, channel)` key keeps
  the planner SEEKing them instead of silently scanning.

  The `visitors` folded-nick index was already dropped in phase 7
  (`20260712130000`); identity uniqueness lives on `network_credentials`.

  ## Migration policy — forward-only, DETECT-and-fail, never guess

  vjt's call (#525): **no un-merge, no split, no guess-delete.** Rows that
  already merged under the wider rfc1459 fold cannot be un-merged — the
  original bracket-vs-brace spelling is unrecoverable. So:

    * **Channel-VALUE tables stay put** (`messages.channel`,
      `read_cursors.channel`, `network_featured_channels.name`,
      `network_credentials.autojoin_channels` / `last_joined_channels`).
      They store the FOLDED value + a plain index; refolding is
      impossible and history stays where it is. A brace-spelled channel
      keeps its scrollback; a bracket-spelled one starts a fresh window.
      Nothing to do here.
    * **Expression indexes are recreated** with `lower()` (above).

  ### Collision detection (`refuse_on_collision!/1`)

  Recreating a UNIQUE index with the NARROWER ASCII fold on data that was
  unique under the WIDER rfc1459 fold can NEVER collide: rfc1459 folds a
  superset of ASCII, so rows distinct under rfc1459 are automatically
  distinct under ASCII. vjt measured prod (2026-07-29): zero colliding
  pairs. But a hand-edited / drifted DB could hide a pair the wider fold
  masked. Per #525 the migration must **detect a collision and fail LOUD
  rather than guess** — so before touching any index it runs the ASCII
  collision probe on all five UNIQUE-index branches and `raise`s (aborting
  the transaction) if any group has > 1 row. It never deletes a "loser".
  On prod as measured this path does not fire; it is the difference
  between a migration that is safe and one that merely got lucky.

  ## Cold deploy

  New migration — the hot deploy path skips `ecto.migrate`, so this MUST
  be cold-deployed: the index swap must land before any session boot reads
  the narrowed runtime fold against a still-rfc1459 index.

  ## down/0 — reintroduces the over-fold (paired with a code revert)

  The inverse restores the rfc1459 indexes. That REINTRODUCES the #525
  over-fold, so a rollback is only coherent paired with reverting the
  `Identifier` code (else `lower()` queries would miss the rfc1459 index).
  It is also the MERGING direction, so `create unique_index` may fail if
  post-#525 data now holds two bracket-distinct identities the rfc1459
  fold would merge — that failure is honest (you cannot return to the
  merged world without picking a loser). Forward-only in spirit.
  """
  use Ecto.Migration

  # Every LIVE UNIQUE fold index, as {table, column, subject_where,
  # group_prefix_cols}. The collision probe groups by
  # `group_prefix_cols ++ [lower(column)]`; the going-forward index is
  # `group_prefix_cols ++ [lower(column)]` too (network_credentials is the
  # one whose index lists the fold FIRST — see up/0 — but the collision
  # grouping is order-independent).
  @unique_branches [
    {"query_windows", "target_nick", "user_id IS NOT NULL", ["user_id", "network_id"]},
    {"query_windows", "target_nick", "visitor_id IS NOT NULL", ["visitor_id", "network_id"]},
    {"notify_entries", "nick", "user_id IS NOT NULL", ["user_id", "network_id"]},
    {"notify_entries", "nick", "visitor_id IS NOT NULL", ["visitor_id", "network_id"]},
    {"network_credentials", "nick", "visitor_id IS NOT NULL", ["network_id"]}
  ]

  def up do
    # Phase 1 — detect, abort LOUD before any index is touched.
    refuse_on_collision!(repo())

    # Phase 2 — swap each UNIQUE folded index rfc1459 → ASCII (same name).
    swap_unique(
      :query_windows,
      :query_windows_user_network_nick_folded_index,
      ["user_id", "network_id", "lower(target_nick)"],
      "user_id IS NOT NULL"
    )

    swap_unique(
      :query_windows,
      :query_windows_visitor_network_nick_folded_index,
      ["visitor_id", "network_id", "lower(target_nick)"],
      "visitor_id IS NOT NULL"
    )

    swap_unique(
      :notify_entries,
      :notify_entries_user_network_nick_folded_index,
      ["user_id", "network_id", "lower(nick)"],
      "user_id IS NOT NULL"
    )

    swap_unique(
      :notify_entries,
      :notify_entries_visitor_network_nick_folded_index,
      ["visitor_id", "network_id", "lower(nick)"],
      "visitor_id IS NOT NULL"
    )

    swap_unique(
      :network_credentials,
      :network_credentials_visitor_folded_nick_network_id_index,
      ["lower(nick)", "network_id"],
      "visitor_id IS NOT NULL"
    )

    # Phase 3 — the #393 DM-peer covering indexes (non-unique, no
    # collision risk); refold the COALESCE key so reads keep SEEKing.
    swap_covering(
      :messages,
      :messages_user_id_network_id_dm_coalesce_fold_id_kind_index,
      ["user_id", "network_id", "lower(COALESCE(dm_with, channel))", "id", "kind"]
    )

    swap_covering(
      :messages,
      :messages_visitor_id_network_id_dm_coalesce_fold_id_kind_index,
      ["visitor_id", "network_id", "lower(COALESCE(dm_with, channel))", "id", "kind"]
    )
  end

  def down do
    # Inverse — restore the rfc1459 indexes (reintroduces the #525
    # over-fold; pair with a code revert). No collision guard: this is the
    # merging direction, so a genuine bracket-distinct pair makes the
    # rfc1459 `create unique_index` fail LOUD, which is correct.
    swap_unique(
      :query_windows,
      :query_windows_user_network_nick_folded_index,
      ["user_id", "network_id", rfc1459("target_nick")],
      "user_id IS NOT NULL"
    )

    swap_unique(
      :query_windows,
      :query_windows_visitor_network_nick_folded_index,
      ["visitor_id", "network_id", rfc1459("target_nick")],
      "visitor_id IS NOT NULL"
    )

    swap_unique(
      :notify_entries,
      :notify_entries_user_network_nick_folded_index,
      ["user_id", "network_id", rfc1459("nick")],
      "user_id IS NOT NULL"
    )

    swap_unique(
      :notify_entries,
      :notify_entries_visitor_network_nick_folded_index,
      ["visitor_id", "network_id", rfc1459("nick")],
      "visitor_id IS NOT NULL"
    )

    swap_unique(
      :network_credentials,
      :network_credentials_visitor_folded_nick_network_id_index,
      [rfc1459("nick"), "network_id"],
      "visitor_id IS NOT NULL"
    )

    swap_covering(
      :messages,
      :messages_user_id_network_id_dm_coalesce_fold_id_kind_index,
      ["user_id", "network_id", rfc1459("COALESCE(dm_with, channel)"), "id", "kind"]
    )

    swap_covering(
      :messages,
      :messages_visitor_id_network_id_dm_coalesce_fold_id_kind_index,
      ["visitor_id", "network_id", rfc1459("COALESCE(dm_with, channel)"), "id", "kind"]
    )
  end

  @doc """
  Returns the list of ASCII-fold collisions across every LIVE UNIQUE fold
  index branch — one row per colliding group (subject cols, folded key,
  count). Empty list means the re-fold is safe. Public so both `up/0` and
  the migration test can exercise the exact detection SQL against a seeded
  DB (the repo is passed in — a plain call has no migration `repo()`).
  """
  @spec ascii_collisions(module()) :: [{String.t(), String.t(), String.t(), list()}]
  def ascii_collisions(repo) do
    Enum.flat_map(@unique_branches, fn {table, col, where, group_cols} ->
      group = Enum.join(group_cols ++ ["lower(#{col})"], ", ")
      select = Enum.join(group_cols ++ ["lower(#{col})", "COUNT(*)"], ", ")

      sql = """
      SELECT #{select}
      FROM #{table}
      WHERE #{where}
      GROUP BY #{group}
      HAVING COUNT(*) > 1
      """

      %{rows: rows} = repo.query!(sql)
      Enum.map(rows, &{table, col, where, &1})
    end)
  end

  @doc """
  Detect ASCII-fold collisions and `raise` if any exist (#525: fail loud,
  never guess/un-merge). `:ok` when clean. Split from `up/0` so the raise
  behaviour is testable without a migration runner.
  """
  @spec refuse_on_collision!(module()) :: :ok
  def refuse_on_collision!(repo) do
    case ascii_collisions(repo) do
      [] ->
        :ok

      collisions ->
        raise """
        #525 re-fold aborted: #{length(collisions)} ASCII-fold collision(s) the \
        wider rfc1459 index was masking. Un-merging stored history is impossible \
        — resolve each colliding pair by hand, then re-run. Never guessed a \
        "loser" row. Colliding groups {table, column, where, [group..., folded, count]}:
        #{Enum.map_join(collisions, "\n", &inspect/1)}
        """
    end
  end

  # rfc1459 fold (down/0 only) — the pre-#525 expression, restored on
  # rollback. Kept identical to the historical migrations.
  defp rfc1459(col) do
    "replace(replace(replace(replace(lower(#{col}), '[', '{'), ']', '}'), '\\', '|'), '~', '^')"
  end

  # Swap a UNIQUE expression index to `cols` keeping its NAME. DROP by name
  # (works whichever fold currently backs it), then CREATE the new form.
  defp swap_unique(table, name, cols, where) do
    execute("DROP INDEX IF EXISTS #{name}")
    create unique_index(table, cols, name: name, where: where)
  end

  # Swap a NON-unique (covering) expression index to `cols` keeping NAME.
  defp swap_covering(table, name, cols) do
    execute("DROP INDEX IF EXISTS #{name}")
    create index(table, cols, name: name)
  end
end
