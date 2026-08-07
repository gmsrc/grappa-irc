defmodule Grappa.Repo.Migrations.FoldNickservPassOntoPassword do
  @moduledoc """
  GH #124 — fold the retired `network_credentials.nickserv_pass_encrypted`
  secret onto `password_encrypted`, so the NickServ password has exactly ONE
  home.

  ## Why this runs at all

  #509 gave the credential a SECOND NickServ secret, editable from the perform
  editor, and made it WIN over `password_encrypted`
  (`Credential.recover_secret/1`, `Session.Server.nickserv_secret/1`). Two
  editable homes for one secret is the split brain #124 is named after: the
  operator repairs one and the other keeps driving the identify. #124 collapses
  the read side to `password_encrypted` alone.

  That collapse ALONE would silently break every operator who used the perform
  field: their live secret sits in the column nothing reads any more, so the
  next reconnect identifies with a stale password (or none), and the failure is
  a silent non-`+r` rather than an error. This migration moves the value first.

  ## The fold PRESERVES today's effective secret, it does not merge

  `nickserv_pass_encrypted` WON the old precedence, so where it is present it
  is what upstream is actually being identified with — and it therefore
  OVERWRITES `password_encrypted` rather than filling in only where that is
  NULL. Filling the gaps would have quietly demoted a working secret to the
  losing one on every row that carried both.

  ## GH #1028 — the fold carries the SAME `auth_method` guard as the promotion

  The rule the promotion follows is not "do not rewrite `auth_method`". It is
  **do not rewrite the VALUE on a row whose password is SPENT somewhere else**,
  and the promotion was only its first half. On `:server_pass` and `:auto`
  `password_encrypted` is the single `PASS` wire token
  (`AuthFSM.maybe_send_pass/1`); on `:sasl` and `:auto` it is the SASL PLAIN
  payload. On none of the three is it the NickServ secret, so there the fold
  preserves nothing — it DESTROYS a live server password, and `down/0` cannot
  put it back because the pre-fold value is gone. Shipped unguarded in v0.14.0;
  what the operator sees is `Closing Link: wrong password`, with nothing
  pointing back here.

  So the fold now writes ONLY where the promotion above just acted: rows that
  were at `:none`. That is deliberately the NARROWEST guard that stops the
  data loss, and it writes strictly less than the previous statement did.

  ## Known consequence of the narrow guard — open, not resolved here

  A row already at `:nickserv_identify` carrying a perform-held secret is now
  NOT folded. Under the old precedence `nickserv_pass_encrypted` WON, so that
  is the secret upstream is really being identified with; post-#124 nothing
  reads that column any more, so the identify falls back to whatever
  `password_encrypted` holds and fails SILENTLY (a non-`+r`, not an error).

  That is a real gap and it is left standing on purpose. It is not symmetric
  with the bug above: nothing is destroyed here. The value is still in
  `nickserv_pass_encrypted`, which #124 keeps in place (EXPAND only), so this
  row can be repaired later by any decision — whereas a folded `:server_pass`
  row cannot be repaired at all. Between "write and maybe have to undo it" and
  "do not write yet", a data-loss fix takes the second. Where the NickServ
  secret should live for these rows is vjt's call; see GH #1028.

  ## Ciphertext copy, not decrypt-and-re-encrypt

  Both columns are `Grappa.EncryptedBinary` (`Cloak.Ecto.Binary`) on the SAME
  `Grappa.Vault`, and Cloak binds no column name / AAD into the ciphertext, so
  the BLOB is portable between them verbatim. Copying bytes keeps this
  migration free of the Vault entirely — it needs no key material and cannot
  fail on a mis-set `GRAPPA_ENCRYPTION_KEY`, which a decrypt-and-re-encrypt
  pass would. `fold_nickserv_pass_onto_password_test.exs` proves the copied
  BLOB decrypts to the original plaintext rather than asserting it here.

  The one shape a byte copy cannot inspect is an encrypted EMPTY string, which
  would clobber a real password with an inert `""`. It cannot arise from the
  application path: `Credential.put_encrypted_perform_field/3` maps `""` to
  `nil` (SQL NULL) on every write the perform editor ever made, so a non-NULL
  value is always a non-empty secret.

  ## `auth_method` promotion

  #509 deliberately DECOUPLED the second secret from `auth_method`, so a row
  can hold a NickServ password while sitting at `:none`. Once the secret is the
  credential password, `:none` means "do not identify" and the fold would
  disarm it. Rows carrying a folded secret at `:none` are promoted to
  `:nickserv_identify` — the same promotion `Credentials.commit_visitor_password/3`
  already applies for the same reason. Only `:none` is promoted: rewriting
  `:sasl` or `:server_pass` would change what the password is SPENT ON and
  break a working handshake.

  ## Scope: EXPAND only

  The column is deliberately LEFT IN PLACE (vjt's scope ruling on #124).
  Dropping it is CONTRACT — it needs a cold window, and the cure was not to be
  held hostage to scheduling one. Nothing reads or writes it after #124; the
  follow-up that drops it is mechanical.

  ## Idempotency

  Re-running is a no-op in effect: the fold is value-idempotent (copying the
  same BLOB again yields the same password) and the promotion's `auth_method =
  'none'` guard stops matching after the first pass. New migration — Preflight
  classifies any `priv/repo/migrations/*` change as COLD, so it runs before the
  collapsed read path serves a single session.

  Irreversible by construction: `down/0` cannot know which rows had a
  `password_encrypted` of their own before the overwrite.
  """
  use Ecto.Migration

  def up do
    # ORDER REVERSED by #1028, and it is now load-bearing rather than a matter
    # of taste. Both statements match on `auth_method = 'none'`, so the two are
    # no longer independent: promoting first flips the row to
    # `:nickserv_identify` and the fold's own WHERE stops matching it — the copy
    # then reaches NOTHING and the migration is a silent no-op for exactly the
    # rows it exists to serve. Caught by
    # `fold_nickserv_pass_onto_password_test.exs`, which went red on the `:none`
    # case the moment the guard was added without the swap.
    #
    # Folding first is correct and stays idempotent: on a re-run the fold finds
    # no `:none` row left to copy and the promotion finds none left to flip.
    execute("""
    UPDATE network_credentials
       SET password_encrypted = nickserv_pass_encrypted
     WHERE nickserv_pass_encrypted IS NOT NULL
       AND auth_method = 'none'
    """)

    execute("""
    UPDATE network_credentials
       SET auth_method = 'nickserv_identify'
     WHERE nickserv_pass_encrypted IS NOT NULL
       AND auth_method = 'none'
    """)
  end

  def down do
    raise Ecto.MigrationError,
      message:
        "#124 fold is irreversible: the pre-fold password_encrypted was overwritten and is not recoverable"
  end
end
