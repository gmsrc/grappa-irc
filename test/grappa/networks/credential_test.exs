defmodule Grappa.Networks.CredentialTest do
  use Grappa.DataCase, async: true

  alias Grappa.Networks.Credential

  describe "ident field (#152)" do
    defp base_attrs(extra) do
      Map.merge(
        %{user_id: Ecto.UUID.generate(), network_id: 1, nick: "vjt", auth_method: :none},
        extra
      )
    end

    test "effective_ident/1 falls back to nick when ident is nil" do
      assert Credential.effective_ident(%Credential{ident: nil, nick: "vjt"}) == "vjt"
    end

    test "effective_ident/1 returns the ident when set" do
      assert Credential.effective_ident(%Credential{ident: "grp", nick: "vjt"}) == "grp"
    end

    test "changeset casts a valid ident" do
      cs = Credential.changeset(%Credential{}, base_attrs(%{ident: "grp_1"}))
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :ident) == "grp_1"
    end

    test "changeset strips a leading tilde before validating (anti-spoof)" do
      cs = Credential.changeset(%Credential{}, base_attrs(%{ident: "~grp"}))
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :ident) == "grp"
    end

    test "changeset rejects an ident over 10 chars" do
      cs = Credential.changeset(%Credential{}, base_attrs(%{ident: String.duplicate("a", 11)}))
      refute cs.valid?
      assert "must be a valid IRC ident" in errors_on(cs).ident
    end

    test "changeset rejects an ident with @ or whitespace" do
      assert "must be a valid IRC ident" in errors_on(Credential.changeset(%Credential{}, base_attrs(%{ident: "a@b"}))).ident

      assert "must be a valid IRC ident" in errors_on(Credential.changeset(%Credential{}, base_attrs(%{ident: "a b"}))).ident
    end

    test "changeset rejects a residual tilde (~~evil sanitizes to ~evil, still invalid)" do
      cs = Credential.changeset(%Credential{}, base_attrs(%{ident: "~~evil"}))
      refute cs.valid?
      assert "must be a valid IRC ident" in errors_on(cs).ident
    end

    test "ident is optional (nil passes)" do
      assert Credential.changeset(%Credential{}, base_attrs(%{})).valid?
    end
  end

  describe "profile_changeset/2 (KVIrc-style CTCP USERINFO profile)" do
    test "casts all 5 profile fields" do
      cs =
        Credential.profile_changeset(%Credential{}, %{
          profile_age: "30",
          profile_gender: :female,
          profile_location: "Italy",
          profile_languages: "it, en",
          profile_custom: "here for the vibes"
        })

      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :profile_age) == "30"
      assert Ecto.Changeset.get_change(cs, :profile_gender) == :female
      assert Ecto.Changeset.get_change(cs, :profile_location) == "Italy"
      assert Ecto.Changeset.get_change(cs, :profile_languages) == "it, en"
      assert Ecto.Changeset.get_change(cs, :profile_custom) == "here for the vibes"
    end

    test "an empty attrs map is a valid no-op" do
      assert Credential.profile_changeset(%Credential{}, %{}).valid?
    end

    test "profile_gender rejects a value outside the closed set" do
      cs = Credential.profile_changeset(%Credential{}, %{profile_gender: :robot})
      refute cs.valid?
      assert "is invalid" in errors_on(cs).profile_gender
    end

    test "profile_gender accepts each of male/female/nonbinary" do
      for gender <- Credential.genders() do
        cs = Credential.profile_changeset(%Credential{}, %{profile_gender: gender})
        assert cs.valid?, "expected #{inspect(gender)} to be a valid gender"
      end
    end

    test "rejects a CRLF-injected free-text field (wire-hygiene guard)" do
      for field <- [:profile_age, :profile_location, :profile_languages, :profile_custom] do
        cs = Credential.profile_changeset(%Credential{}, %{field => "evil\r\nQUIT"})
        refute cs.valid?, "expected #{field} with an embedded CRLF to be rejected"
      end
    end

    test "rejects a free-text field over the byte cap" do
      too_long = String.duplicate("a", 101)

      for field <- [:profile_age, :profile_location, :profile_languages, :profile_custom] do
        cs = Credential.profile_changeset(%Credential{}, %{field => too_long})
        refute cs.valid?, "expected #{field} over 100 bytes to be rejected"
        assert "must be at most 100 bytes" in errors_on(cs)[field]
      end
    end

    test "accepts a free-text field at exactly the byte cap" do
      exactly_100 = String.duplicate("a", 100)

      for field <- [:profile_age, :profile_location, :profile_languages, :profile_custom] do
        cs = Credential.profile_changeset(%Credential{}, %{field => exactly_100})
        assert cs.valid?, "expected #{field} at exactly 100 bytes to be accepted"
      end
    end

    test "profile_snapshot/1 projects the 5 fields into a plain map" do
      cred = %Credential{
        profile_age: "30",
        profile_gender: :nonbinary,
        profile_location: "Italy",
        profile_languages: "it",
        profile_custom: "custom"
      }

      assert Credential.profile_snapshot(cred) == %{
               age: "30",
               gender: :nonbinary,
               location: "Italy",
               languages: "it",
               custom: "custom"
             }
    end
  end

  describe "has_nickserv_secret?/1 (#581 — /recover button gate)" do
    # Post-Cloak-load, the `*_encrypted` fields carry DECRYPTED plaintext
    # (accessor contract), so a plain struct exercises the predicate without
    # the DB — mirrors the `effective_ident/1` unit tests above.
    test "true for :nickserv_identify with an upstream password (the ONLY source, #124)" do
      cred = %Credential{auth_method: :nickserv_identify, password_encrypted: "hunter2"}
      assert Credential.has_nickserv_secret?(cred)
    end

    test "false with no secret at all" do
      refute Credential.has_nickserv_secret?(%Credential{auth_method: :none})
    end

    test "false when an :nickserv_identify credential has no password" do
      refute Credential.has_nickserv_secret?(%Credential{auth_method: :nickserv_identify})
    end

    test "an empty-string secret is treated as absent (mirrors the live gate's pw != \"\")" do
      refute Credential.has_nickserv_secret?(%Credential{
               auth_method: :nickserv_identify,
               password_encrypted: ""
             })
    end

    test "false for :server_pass with only an upstream password (spent on PASS, not NickServ)" do
      cred = %Credential{auth_method: :server_pass, password_encrypted: "shibboleth"}
      refute Credential.has_nickserv_secret?(cred)
    end

    test "#1044 — the server-PASS slot does not grant the gate" do
      # Pre-#124 the second column WAS a NickServ source (#509, decoupled from
      # auth_method) and this was TRUE. #1044 reopened that column for a
      # DIFFERENT role, and #124's property has to hold against it: one role,
      # one home, no fallback chain. A server password is not something
      # /recover can identify with.
      cred = %Credential{auth_method: :server_pass, server_pass_encrypted: "hunter2"}
      refute Credential.has_nickserv_secret?(cred)
    end
  end

  describe "recover_secret/1 (#581 — the /recover secret VALUE, SSOT for button + action)" do
    # The value `Session.Server`'s /recover action IDENTIFYs with.
    # `has_nickserv_secret?/1` is `not is_nil(recover_secret/1)`, so button and
    # action read ONE source and can never diverge (review-#1). Post-Cloak-load
    # the `*_encrypted` fields carry DECRYPTED plaintext (accessor contract),
    # so a plain struct exercises it without the DB.
    test "returns the :nickserv_identify upstream password (the single source, #124)" do
      cred = %Credential{auth_method: :nickserv_identify, password_encrypted: "hunter2"}
      assert Credential.recover_secret(cred) == "hunter2"
    end

    test "nil with no secret at all" do
      assert Credential.recover_secret(%Credential{auth_method: :none}) == nil
    end

    test "nil for :server_pass with only an upstream password (spent on PASS, not NickServ)" do
      cred = %Credential{auth_method: :server_pass, password_encrypted: "shibboleth"}
      assert Credential.recover_secret(cred) == nil
    end

    test "an empty-string password is treated as absent (falls through to nil)" do
      assert Credential.recover_secret(%Credential{
               auth_method: :nickserv_identify,
               password_encrypted: ""
             }) == nil
    end

    test "#1044 — the server-PASS slot is NOT read" do
      cred = %Credential{auth_method: :server_pass, server_pass_encrypted: "hunter2"}
      assert Credential.recover_secret(cred) == nil
    end

    test "#1044 — the NickServ secret is resolved with the server-PASS slot also set" do
      # Pre-#124 the second column WON this exact shape ("$nickserv_pass WINS
      # over the :nickserv_identify password"). There is no precedence to
      # re-open: the two slots hold two different roles, and this one reads
      # `password_encrypted` and nothing else.
      cred = %Credential{
        auth_method: :nickserv_identify,
        server_pass_encrypted: "hunter2",
        password_encrypted: "ns-secret"
      }

      assert Credential.recover_secret(cred) == "ns-secret"
    end
  end

  describe "connection_state field (T32)" do
    test "round-trips :connected | :parked | :failed via changeset" do
      # `get_field` (not `get_change`) — `:connected` is the schema
      # default, so casting it is a no-op and `get_change` would
      # return nil for that case while `get_field` reflects the
      # effective value (default-merged).
      for state <- [:connected, :parked, :failed] do
        cs =
          Credential.changeset(%Credential{}, %{
            user_id: Ecto.UUID.generate(),
            network_id: 1,
            nick: "vjt",
            auth_method: :none,
            connection_state: state
          })

        assert Ecto.Changeset.get_field(cs, :connection_state) == state
      end
    end

    test "rejects unknown atoms at Ecto.Enum boundary" do
      cs =
        Credential.changeset(%Credential{}, %{
          user_id: Ecto.UUID.generate(),
          network_id: 1,
          nick: "vjt",
          auth_method: :none,
          connection_state: :bogus
        })

      refute cs.valid?
      assert "is invalid" in errors_on(cs).connection_state
    end

    test "connection_state_reason accepts a free-form string" do
      cs =
        Credential.changeset(%Credential{}, %{
          user_id: Ecto.UUID.generate(),
          network_id: 1,
          nick: "vjt",
          auth_method: :none,
          connection_state: :failed,
          connection_state_reason: "k-line: G:Lined (host eviction)"
        })

      assert Ecto.Changeset.get_change(cs, :connection_state_reason) ==
               "k-line: G:Lined (host eviction)"
    end

    test "connection_state_changed_at accepts a UTC datetime" do
      ts = ~U[2026-05-04 12:34:56Z]

      cs =
        Credential.changeset(%Credential{}, %{
          user_id: Ecto.UUID.generate(),
          network_id: 1,
          nick: "vjt",
          auth_method: :none,
          connection_state: :parked,
          connection_state_changed_at: ts
        })

      assert Ecto.Changeset.get_change(cs, :connection_state_changed_at) == ts
    end
  end

  describe "subject XOR (#211 phase 1)" do
    # Mirror of `Grappa.ReadCursor.Cursor`'s subject-XOR contract:
    # exactly one of `:user_id` / `:visitor_id` is set. Errors attach
    # to the synthetic `:subject` key for uniform client rendering.
    defp xor_attrs(extra) do
      Map.merge(%{network_id: 1, nick: "vjt", auth_method: :none}, extra)
    end

    test "accepts a user-only credential (visitor_id nil)" do
      cs = Credential.changeset(%Credential{}, xor_attrs(%{user_id: Ecto.UUID.generate()}))
      assert cs.valid?
    end

    test "accepts a visitor-only credential (user_id nil)" do
      cs = Credential.changeset(%Credential{}, xor_attrs(%{visitor_id: Ecto.UUID.generate()}))
      assert cs.valid?
    end

    test "rejects a both-null subject" do
      cs = Credential.changeset(%Credential{}, xor_attrs(%{}))
      refute cs.valid?
      assert "must set user_id or visitor_id" in errors_on(cs).subject
    end

    test "rejects a both-set subject (user_id AND visitor_id)" do
      cs =
        Credential.changeset(
          %Credential{},
          xor_attrs(%{user_id: Ecto.UUID.generate(), visitor_id: Ecto.UUID.generate()})
        )

      refute cs.valid?
      assert "user_id and visitor_id are mutually exclusive" in errors_on(cs).subject
    end

    test "casts visitor_id" do
      vid = Ecto.UUID.generate()
      cs = Credential.changeset(%Credential{}, xor_attrs(%{visitor_id: vid}))
      assert Ecto.Changeset.get_change(cs, :visitor_id) == vid
    end
  end
end
