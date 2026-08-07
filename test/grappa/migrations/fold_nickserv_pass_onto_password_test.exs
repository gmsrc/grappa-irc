defmodule Grappa.Migrations.FoldNickservPassOntoPasswordTest do
  @moduledoc """
  GH #124 — the expand-phase fold migration
  (`20260807120000_fold_nickserv_pass_onto_password`).

  #509's `nickserv_pass_encrypted` held LIVE secrets and WON the old
  precedence, so collapsing the read path onto `password_encrypted` without
  moving those values would break exactly the operators who used the perform
  field — silently, at the next reconnect, as a non-`+r` rather than an error.

  Seeds the three real row shapes the fold meets in production and proves none
  of them gets worse:

    * perform-held secret on an `auth_method: :none` row — the #509 decoupled
      shape. Folds, AND promotes to `:nickserv_identify`, else the fold would
      disarm a working identify.
    * no perform-held secret — untouched, both at `:none` and at
      `:nickserv_identify` with a password of its own (the already-correct row).
    * BOTH set — the perform secret OVERWRITES the password, because it is what
      upstream was actually being identified with under the old precedence.

  Also pins the thing a byte-level BLOB copy has to earn: that the copied
  ciphertext still DECRYPTS to the original plaintext through
  `Credential.upstream_password/1`. That is the whole reason the migration may
  skip the Vault.

  The SQL is duplicated here (migrations stay self-contained per repo
  convention — see `CollapseNickReadCursorsTest`), and a pin test asserts the
  migration file embeds these exact statements, so the duplication cannot drift
  into testing a copy the migration no longer runs.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{EncryptedBinary, Repo}
  alias Grappa.Networks.Credential

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
     AND auth_method IN ('none', 'nickserv_identify')
  """

  defp uniq, do: System.unique_integer([:positive])

  defp seed(attrs) do
    user = user_fixture(name: "vjt-#{uniq()}")
    {network, _} = network_with_server(port: 6667, slug: "azzurra-#{uniq()}")
    credential_fixture(user, network, attrs)
  end

  # The #509 write path is GONE (#124 removed the virtual + its changeset cast),
  # so a pre-#124 row can only be staged by writing the ciphertext directly —
  # which is also the honest reproduction of what is sitting in prod today.
  defp seed_perform_secret(%Credential{} = cred, plaintext) do
    {:ok, blob} = EncryptedBinary.dump(plaintext)

    Repo.query!(
      "UPDATE network_credentials SET nickserv_pass_encrypted = ? WHERE id = ?",
      [blob, cred.id]
    )

    cred
  end

  defp run_migration do
    Repo.query!(@promote_sql)
    Repo.query!(@fold_sql)
  end

  defp reload(%Credential{id: id}), do: Repo.get!(Credential, id)

  describe "the fold (#124 expand phase)" do
    test "a perform-held secret on an :none row folds onto the password AND promotes" do
      cred =
        %{auth_method: :none, password: nil}
        |> seed()
        |> seed_perform_secret("perform-secret")

      run_migration()

      folded = reload(cred)

      # Decrypts: the BLOB copy really did survive as the same plaintext, which
      # is what lets the migration skip the Vault entirely.
      assert Credential.upstream_password(folded) == "perform-secret"
      assert folded.auth_method == :nickserv_identify

      # And the collapsed read path now resolves it — the end-to-end point of
      # the fold, asserted through production code rather than the column.
      assert Credential.recover_secret(folded) == "perform-secret"
    end

    test "a perform-held secret OVERWRITES an existing password (it won the old precedence)" do
      cred =
        %{auth_method: :nickserv_identify, password: "loser"}
        |> seed()
        |> seed_perform_secret("winner")

      run_migration()

      # Pre-#124 `recover_secret/1` answered "winner" for this row. Filling in
      # only where the password was NULL would have silently demoted upstream's
      # actual secret to the one that was losing.
      assert Credential.recover_secret(reload(cred)) == "winner"
    end

    test "a row with no perform-held secret is untouched (the already-correct shape)" do
      cred = seed(%{auth_method: :nickserv_identify, password: "mine"})

      run_migration()

      folded = reload(cred)
      assert Credential.upstream_password(folded) == "mine"
      assert folded.auth_method == :nickserv_identify
    end

    test "an :none row with no perform-held secret is NOT promoted" do
      cred = seed(%{auth_method: :none, password: nil})

      run_migration()

      folded = reload(cred)
      assert folded.auth_method == :none
      assert Credential.recover_secret(folded) == nil
    end

    # GH #1028 — the three methods that SPEND `password_encrypted` on the wire.
    # `:server_pass` and `:auto` ship it as the single PASS token
    # (`AuthFSM.maybe_send_pass/1`, `when m in [:auto, :server_pass]`); `:auto`
    # and `:sasl` also spend it as the SASL PLAIN payload. On none of the three
    # is it the NickServ secret, so folding the perform secret onto it does not
    # preserve an effective secret — it DESTROYS a live one, and `down/0`
    # cannot put it back.
    #
    # Generated rather than written three times: the claim is about a CLOSED
    # SET (`Credential.auth_methods/0` minus the two the fold is for), and a
    # fourth method added later must be a deliberate decision, not an omission.
    for method <- [:server_pass, :sasl, :auto] do
      test "#{method}: the fold leaves the password alone — it is spent on the wire, not on NickServ" do
        cred =
          %{auth_method: unquote(method), password: "wire-side"}
          |> seed()
          |> seed_perform_secret("ns-side")

        run_migration()

        folded = reload(cred)
        # Not promoted: rewriting the method would change what the password is
        # SPENT ON. This half was always true.
        assert folded.auth_method == unquote(method)
        # Not folded either — the #1028 half. Before the guard this read
        # "ns-side", and the row's upstream handshake died with
        # `Closing Link: wrong password`.
        assert Credential.upstream_password(folded) == "wire-side"
      end
    end

    test "re-running the fold changes nothing (idempotent)" do
      cred =
        %{auth_method: :none, password: nil}
        |> seed()
        |> seed_perform_secret("perform-secret")

      run_migration()
      once = reload(cred)
      run_migration()
      twice = reload(cred)

      assert Credential.upstream_password(twice) == Credential.upstream_password(once)
      assert twice.auth_method == once.auth_method
    end
  end

  describe "migration-file pin" do
    # The SQL above is a COPY (repo convention: migrations stay self-contained).
    # Without this pin the copy could drift and the suite would go on proving a
    # fold the migration no longer performs.
    #
    # Compared with whitespace runs collapsed, NOT byte-for-byte: the migration
    # indents its heredoc bodies to sit inside `execute(...)`, so a literal
    # comparison would pin the indentation rather than the statement. Every
    # part that decides what the fold DOES — the table, the SET, the WHERE
    # guards — still has to match exactly.
    test "the migration file embeds both statements" do
      source = squash(File.read!(Path.join(File.cwd!(), @migration_path)))

      assert embeds?(source, @promote_sql)
      assert embeds?(source, @fold_sql)
    end

    defp squash(text), do: text |> String.replace(~r/\s+/, " ") |> String.trim()

    # GH #1028 — anchored on the heredoc TERMINATOR, not a bare substring.
    # A plain `String.contains?` is satisfied by a PREFIX, so the copy here
    # could lose a trailing WHERE clause the migration still has and the pin
    # would stay green — measured: with the `auth_method` guard deleted from
    # `@fold_sql` alone, the old pin passed while the three behaviour tests
    # failed. That is the exact drift the pin exists to catch, so it has to see
    # the end of the statement, not just its beginning.
    defp embeds?(source, sql), do: String.contains?(source, squash(sql) <> ~S[ """)])
  end
end
