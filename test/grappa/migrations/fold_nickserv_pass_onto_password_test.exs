defmodule Grappa.Migrations.FoldNickservPassOntoPasswordTest do
  @moduledoc """
  GH #124 — the expand-phase fold migration
  (`20260807120000_fold_nickserv_pass_onto_password`).

  ## What used to be here, and why it is gone (#1044)

  This file used to seed the three real row shapes the fold meets in
  production and prove that none of them got worse — a behaviour suite that
  replayed the fold's own SQL against the live test schema.

  #1044 DROPPED `nickserv_pass_encrypted`
  (`20260811130000_swap_nickserv_pass_slot_for_server_pass`). The test schema
  is built by running every migration in order, so by the time a test runs,
  the column the fold reads does not exist and the replay cannot be issued at
  all. The behaviour tests were deleted rather than adapted: there is no
  schema this suite can build on which that SQL is executable, and a rewrite
  onto a stand-in table would be asserting against a table the migration never
  touches.

  The migration itself is untouched and still correct: on an upgrading
  database it runs BEFORE the drop, in migration order, exactly as it always
  did. What is lost is the witness, not the behaviour — say so out loud rather
  than let the deletion read as "this stopped mattering".

  ## What survives

  The source pin below. It is a text assertion, so it keeps working after the
  drop, and it still earns its place: the migration is frozen history now, and
  the pin fails loudly if anyone edits the statements a shipped database has
  already run.
  """
  use ExUnit.Case, async: true

  @migration_path "priv/repo/migrations/20260807120000_fold_nickserv_pass_onto_password.exs"

  @promote_sql """
  UPDATE network_credentials
     SET auth_method = 'nickserv_identify'
   WHERE nickserv_pass_encrypted IS NOT NULL
     AND auth_method = 'none'
  """

  @fold_sql """
  UPDATE network_credentials
     SET password_encrypted = nickserv_pass_encrypted
   WHERE nickserv_pass_encrypted IS NOT NULL
     AND auth_method = 'none'
  """

  describe "migration-file pin" do
    # A migration that has already run on a production database must never be
    # edited: the edit would not re-run, so the file would stop describing what
    # the schema actually went through. That risk OUTLIVES the column.
    #
    # Compared with whitespace runs collapsed, NOT byte-for-byte: the migration
    # indents its heredoc bodies to sit inside `execute(...)`, so a literal
    # comparison would pin the indentation rather than the statement. Every
    # part that decides what the fold DID — the table, the SET, the WHERE
    # guards — still has to match exactly.
    test "the migration file embeds both statements" do
      source = squash(File.read!(Path.join(File.cwd!(), @migration_path)))

      assert embeds?(source, @promote_sql)
      assert embeds?(source, @fold_sql)
    end

    # GH #1028 — the ORDER, which the two assertions above cannot see. They are
    # independent substring tests, so swapping the two `execute` blocks leaves
    # both green: measured, by swapping them in the migration for real. Order is
    # the one property #1028 exists to protect — promote-first flips the row to
    # `:nickserv_identify` and the fold's own `WHERE` then matches nothing, so
    # the copy reaches NOTHING and the migration is a silent no-op for exactly
    # the rows it serves. Its only witness was the behaviour suite this file
    # deleted, so the pin has to carry the claim now.
    test "the fold statement comes BEFORE the promotion" do
      source = squash(File.read!(Path.join(File.cwd!(), @migration_path)))

      # Positions are destructured as integers before they are compared. A bare
      # `<` over a possible `:nomatch` would be worse than useless: in Elixir's
      # term order every number sorts below every atom, so an ABSENT promotion
      # would read as "the fold comes first" and the pin would pass on a
      # migration that lost half of itself.
      assert {fold_at, _} = :binary.match(source, anchored(@fold_sql))
      assert {promote_at, _} = :binary.match(source, anchored(@promote_sql))

      assert fold_at < promote_at
    end

    defp squash(text), do: text |> String.replace(~r/\s+/, " ") |> String.trim()

    # GH #1028 — anchored on the heredoc TERMINATOR, not a bare substring.
    # A plain `String.contains?` is satisfied by a PREFIX, so the copy here
    # could lose a trailing WHERE clause the migration still has and the pin
    # would stay green — measured: with the `auth_method` guard deleted from
    # `@fold_sql` alone, the old pin passed while the three behaviour tests
    # failed. That is the exact drift the pin exists to catch, so it has to see
    # the end of the statement, not just its beginning.
    defp embeds?(source, sql), do: String.contains?(source, anchored(sql))

    # One definition of the anchor, shared by the presence test and the order
    # test: an anchoring the two could hold differently is an anchoring only one
    # of them has.
    defp anchored(sql), do: squash(sql) <> ~S[ """)]
  end
end
