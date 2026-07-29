defmodule Grappa.Repo.Migrations.CollapseNickReadCursors do
  @moduledoc """
  GH #532 D — collapse the duplicate NICK-keyed `read_cursors` rows a DM
  window accumulated one-per-casing, and fold every nick key to canonical.

  ## Why the earlier fold migration missed these

  `20260723120000_fold_channels_rfc1459` folded `read_cursors.channel`
  but ONLY for CHANNEL-shaped keys (its `substr(channel,1,1) IN
  ('#','&','!','+')` sigil guard). A DM window is keyed by a NICK, which
  sits OUTSIDE that guard by construction, so it was never folded — and
  the cursor WRITE path (`ReadCursor.set/4`) kept minting a new row per
  distinct spelling the client sent, because it canonicalised with the
  sigil-gated `canonical_channel/1` (a no-op for nicks). The read path
  (`Scrollback.channel_or_dm_where/3`) resolved them all case-insensitively
  via `canonical_nick/1`, so a stale lower-`last_read_message_id` row kept
  reporting unread forever with no UI action able to reach it.

  #532 D fixes the write boundary (`Identifier.canonical_target/1`, the
  shape-appropriate fold); this migration converges the historical rows so
  the going-forward key and the stored key agree.

  ## Scope: nick-shaped keys only

  Every statement is guarded by the INVERSE sigil predicate
  (`substr(channel,1,1) NOT IN ('#','&','!','+')`) — the mirror of the
  channel fold migration. Channel-shaped rows are already canonical (that
  migration folded them) and are left untouched here. The `$server`
  pseudo-channel matches the nick guard but `lower('$server')` is a no-op,
  so it is inert.

  ## Fold: ASCII `lower()` — the fold #532 settles on post-#525

  #525 moves the server casemapping from rfc1459 to ASCII (`fold_ascii`,
  A-Z only — bahamut on azzurra is `CASEMAPPING=ascii`, not rfc1459). This
  migration sorts AFTER #525 and therefore uses the SAME ASCII fold
  `Identifier.canonical_nick/1` settles on: a bare `lower()`, no bracket
  replaces. Under ASCII casemapping `nick[1]` and `nick{1}` are DISTINCT
  identities, so NOT collapsing them is correct. Bare `lower()` also keeps
  this migration clear of the rfc1459 fold-literal pin
  (`IdentifierTest` "every folded-index migration embeds the canonical
  fold verbatim").

  ## Collapse tie-break: KEEP MAX(last_read_message_id)

  On a fold-collision we keep the row with the highest
  `last_read_message_id` (tie: highest `id`) and DELETE the rest — the
  operator's furthest-read position is the meaningful one. This is the
  OPPOSITE of #525's "keep the existing/older row" policy, which is the
  wrong tie-break for a read cursor: keeping the older row would preserve
  exactly the stale badge #532 is about. `ORDER BY last_read_message_id
  DESC` puts a NULL cursor last (SQLite sorts NULL smallest), so a real
  read position always wins over a NULL'd one.

  ## Idempotency + cold deploy

  Both statements guard on `channel != lower(channel)` / the MAX-per-group
  survivor, so a re-run is a no-op once rows are canonical. New migration
  — MUST be cold-deployed (the hot path skips `ecto.migrate`) so the
  collapse runs before any session boot reads stale mixed-case rows.
  """
  use Ecto.Migration

  # Nick-shaped keys only — the INVERSE of the channel fold migration's
  # sigil guard. Channels are already canonical; nicks + `$server` fall here.
  @nick_predicate "substr(channel,1,1) NOT IN ('#','&','!','+')"

  def up do
    # Collapse fold-collisions BEFORE the fold UPDATE would violate the
    # partial UNIQUE index on (subject, network_id, channel). Keep the row
    # with MAX(last_read_message_id) per (subject, network_id, lower(nick));
    # tie-break id DESC. Mirrors the channel fold migration's read_cursors
    # collapse, with the sigil guard inverted and the ASCII `lower()` fold.
    execute("""
    DELETE FROM read_cursors
    WHERE rowid NOT IN (
      SELECT rowid
      FROM read_cursors r1
      WHERE #{@nick_predicate}
        AND id = (
          SELECT id
          FROM read_cursors r2
          WHERE r2.network_id = r1.network_id
            AND COALESCE(r2.user_id, '') = COALESCE(r1.user_id, '')
            AND COALESCE(r2.visitor_id, '') = COALESCE(r1.visitor_id, '')
            AND lower(r2.channel) = lower(r1.channel)
            AND substr(r2.channel, 1, 1) NOT IN ('#', '&', '!', '+')
          ORDER BY r2.last_read_message_id DESC, r2.id DESC
          LIMIT 1
        )
    )
    AND #{@nick_predicate}
    """)

    execute("""
    UPDATE read_cursors
    SET channel = lower(channel)
    WHERE channel != lower(channel)
      AND #{@nick_predicate}
    """)
  end

  def down do
    # One-way correction: the original mixed-case spelling is unrecoverable
    # (folded away), so `down` cannot restore it. Documented no-op, mirroring
    # the channel fold + visitor fold migrations' `down`.
    :ok
  end
end
