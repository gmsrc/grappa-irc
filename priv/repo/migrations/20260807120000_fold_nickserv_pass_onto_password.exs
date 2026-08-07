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
    # Order matters: promote FIRST, while `nickserv_pass_encrypted` is still the
    # marker of "this row carried the second secret". Doing it after the copy
    # would work too (the guard reads the same column, which the copy does not
    # touch), but promoting first keeps the two statements independent of each
    # other's effects.
    execute("""
    UPDATE network_credentials
       SET auth_method = 'nickserv_identify'
     WHERE nickserv_pass_encrypted IS NOT NULL
       AND auth_method = 'none'
    """)

    execute("""
    UPDATE network_credentials
       SET password_encrypted = nickserv_pass_encrypted
     WHERE nickserv_pass_encrypted IS NOT NULL
    """)
  end

  def down do
    raise Ecto.MigrationError,
      message:
        "#124 fold is irreversible: the pre-fold password_encrypted was overwritten and is not recoverable"
  end
end
