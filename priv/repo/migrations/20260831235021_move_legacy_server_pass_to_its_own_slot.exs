defmodule Grappa.Repo.Migrations.MoveLegacyServerPassToItsOwnSlot do
  @moduledoc """
  GH #1044 — move the gate secret of every PRE-#1044 `:server_pass` credential
  out of `password_encrypted` and into `server_pass_encrypted`.

  ## Why this has to exist

  The sibling migration (`*_swap_nickserv_pass_slot_for_server_pass`) opened
  the new slot EMPTY, deliberately. Every `:server_pass` row written before it
  therefore still keeps its server `PASS` in `password_encrypted` — which is
  the column #1044 assigns to the NickServ role. The read cutover (`AuthFSM`
  taking the PASS token from the dedicated slot) turns those rows into
  credentials that send no PASS at all: a refused handshake, not a degraded
  one.

  ## Why a move and not a read-side fallback

  "Read the slot, fall back to the password column" is shorter and needs no
  migration. It is also the two-homes-for-one-role split brain that #124 is
  named after: the operator repairs one column and the other keeps driving
  the wire. #124's property — for every role exactly ONE place it is read
  from, with no fallback chain — is a stated invariant, so the bytes move
  once and every reader afterwards has a single source.

  ## The predicate, conjunct by conjunct

    * `auth_method = 'server_pass'` — the only method whose `password_encrypted`
      ever meant "server PASS". On `:auto` the PASS token is the services
      handoff and legitimately stays in `password_encrypted`; on `:sasl` /
      `:nickserv_identify` / `:none` the column was never a gate secret.
    * `user_id IS NOT NULL` — the slot is user-only. A visitor's `auth_method`
      is DERIVED from the presence of its one secret and never reaches
      `:server_pass`, so no visitor row is in scope; the conjunct is the belt
      that keeps a future write path from silently un-identifying one.
    * `server_pass_encrypted IS NULL` — a row whose slot is already populated
      was written through the post-#1044 changeset, so its `password_encrypted`
      is ALREADY the NickServ secret. Overwriting it would destroy that secret
      and duplicate the gate one. This conjunct is also what makes the
      migration idempotent.
    * `password_encrypted IS NOT NULL` — nothing to move otherwise.

  ## Copying a ciphertext between columns

  The values are Cloak AES-GCM blobs and the move is a raw column-to-column
  copy, which is sound only because the ciphertext carries no per-column
  binding (no AAD naming the field, no column-derived key). That was MEASURED
  before this migration was written, with both controls — a same-column round
  trip, and a single corrupted byte that must fail to decrypt — and the
  property is pinned by the migration's own test, which drives the moved value
  back out through the schema rather than comparing blobs.

  ## COLD

  A migration under `priv/repo/migrations` makes the slice cold by
  construction. This one is DATA-only (no shape change), but it must not run
  against a node still serving the pre-cutover code: that code reads the PASS
  from `password_encrypted`, which this empties.

  `down/0` moves back exactly the set `up/0` produces. It cannot be a perfect
  inverse and does not claim to be: a row left at (slot set, password NULL) is
  indistinguishable from one a post-#1044 operator created that way on
  purpose, so the rollback returns such rows to the pre-#1044 shape rather
  than to whatever they were five minutes ago.
  """
  use Ecto.Migration

  def up do
    execute("""
    UPDATE network_credentials
       SET server_pass_encrypted = password_encrypted,
           password_encrypted = NULL
     WHERE auth_method = 'server_pass'
       AND user_id IS NOT NULL
       AND server_pass_encrypted IS NULL
       AND password_encrypted IS NOT NULL
    """)
  end

  def down do
    execute("""
    UPDATE network_credentials
       SET password_encrypted = server_pass_encrypted,
           server_pass_encrypted = NULL
     WHERE auth_method = 'server_pass'
       AND user_id IS NOT NULL
       AND password_encrypted IS NULL
       AND server_pass_encrypted IS NOT NULL
    """)
  end
end
