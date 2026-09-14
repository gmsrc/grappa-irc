defmodule Grappa.UserSettingsDisplayPrefsTest do
  @moduledoc """
  Context tests for the `display_prefs` accessor cluster (#449) on
  `Grappa.UserSettings` — server-backed display preferences so a single
  account converges its UI across devices (report: desktop toggle didn't
  reach the iOS PWA because the prefs were localStorage-only).

  The five prefs: `time_format` (`"hms" | "hm"`, #217), `colored_nicklist`
  (boolean, #443), `presence_filter` (a per-channel tri-state map, #222),
  `show_bottom_bar` (boolean, #1766), and `strip_formatting` (boolean, 2029).

  ## The tri-state invariant (NON-NEGOTIABLE)

  `presence_filter` is `%{channel_key => "show" | "hide"}`. **Unset is the
  ABSENCE of the key**, never a third value and never a boolean. It must
  survive the PUT→GET round-trip as absence — the client derives the
  "follow the size default" behaviour from `LARGE_CHANNEL_THRESHOLD`, and
  the server MUST NOT flatten unset into show/hide/false. Guarded below.

  Follows the established `Grappa.UserSettings` conventions: side-effect-free
  readers with typed defaults, merge-preserve writers (`get_or_init/1` +
  `Map.put(data, key, normalized)`), string-key JSON round-trip, changeset
  errors on the synthetic `:display_prefs` field, and full user/visitor
  parity (visitor-parity V-series).
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.UserSettings
  alias Grappa.UserSettings.Settings

  # ---------------------------------------------------------------------------
  # Fixtures
  # ---------------------------------------------------------------------------

  # A full, valid wire-shape body (string keys, as the controller passes it).
  defp valid_wire(overrides \\ %{}) do
    Map.merge(
      %{
        "time_format" => "hms",
        "colored_nicklist" => false,
        "presence_filter" => %{},
        "show_bottom_bar" => true,
        "strip_formatting" => false,
        "show_event_badge" => false,
        "bold_mentions" => true
      },
      overrides
    )
  end

  # ---------------------------------------------------------------------------
  # get_display_prefs/1 — defensive reader with typed defaults
  # ---------------------------------------------------------------------------

  describe "get_display_prefs/1" do
    test "returns defaults when no settings row exists" do
      fake_id = Ecto.UUID.generate()

      assert UserSettings.get_display_prefs({:user, fake_id}) == %{
               time_format: "hms",
               colored_nicklist: false,
               presence_filter: %{},
               show_bottom_bar: true,
               strip_formatting: false,
               show_event_badge: false,
               bold_mentions: true
             }
    end

    test "returns defaults when the row exists but has no display_prefs key" do
      user = user_fixture()
      # A different accessor populates the row without a display_prefs key.
      {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, ["foo"])

      assert UserSettings.get_display_prefs({:user, user.id}) == %{
               time_format: "hms",
               colored_nicklist: false,
               presence_filter: %{},
               show_bottom_bar: true,
               strip_formatting: false,
               show_event_badge: false,
               bold_mentions: true
             }
    end

    test "fills missing keys from defaults for a partially-populated blob" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})
      # A legacy/partial blob written DIRECTLY — a full-map PUT correctly
      # rejects a partial body, so simulate an older-shape row at the storage
      # layer (mirror of the "malformed" test). The reader must fill the
      # missing keys from defaults, not crash.
      settings
      |> Settings.changeset(%{data: Map.put(settings.data, "display_prefs", %{"time_format" => "hm"})})
      |> Repo.update!()

      assert UserSettings.get_display_prefs({:user, user.id}) == %{
               time_format: "hm",
               colored_nicklist: false,
               presence_filter: %{},
               show_bottom_bar: true,
               strip_formatting: false,
               show_event_badge: false,
               bold_mentions: true
             }
    end

    test "returns defaults when the stored value is malformed (not a map)" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})
      # Simulate a miscoded writer that stored a scalar under the key.
      settings
      |> Settings.changeset(%{data: Map.put(settings.data, "display_prefs", "garbage")})
      |> Repo.update!()

      assert UserSettings.get_display_prefs({:user, user.id}) == %{
               time_format: "hms",
               colored_nicklist: false,
               presence_filter: %{},
               show_bottom_bar: true,
               strip_formatting: false,
               show_event_badge: false,
               bold_mentions: true
             }
    end
  end

  # ---------------------------------------------------------------------------
  # display_prefs_persisted?/1 — seed-up discriminator (#449 Fork B)
  # ---------------------------------------------------------------------------
  #
  # get_display_prefs/1 always returns a complete shape from defaults, so the
  # GET payload alone cannot tell "never written" from "written == defaults".
  # The client's seed-up-once needs that distinction: absent ⇒ push local;
  # present ⇒ server wins. This predicate is the explicit, additive signal.
  # Mirrors get_display_prefs/1's own map guard: a malformed (non-map) blob
  # counts as NOT persisted, so the client seeds up and the row self-heals.

  describe "display_prefs_persisted?/1" do
    test "false when no settings row exists" do
      refute UserSettings.display_prefs_persisted?({:user, Ecto.UUID.generate()})
    end

    test "false when the row exists but has no display_prefs key" do
      user = user_fixture()
      {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, ["foo"])

      refute UserSettings.display_prefs_persisted?({:user, user.id})
    end

    test "true after a put_display_prefs/2 write" do
      user = user_fixture()
      {:ok, _} = UserSettings.put_display_prefs({:user, user.id}, valid_wire())

      assert UserSettings.display_prefs_persisted?({:user, user.id})
    end

    test "false when the stored value is malformed (not a map) — self-heals to seed-up" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      settings
      |> Settings.changeset(%{data: Map.put(settings.data, "display_prefs", "garbage")})
      |> Repo.update!()

      refute UserSettings.display_prefs_persisted?({:user, user.id})
    end

    test "true for a visitor subject after a write (visitor parity)" do
      visitor = visitor_fixture()
      {:ok, _} = UserSettings.put_display_prefs({:visitor, visitor.id}, valid_wire())

      assert UserSettings.display_prefs_persisted?({:visitor, visitor.id})
    end
  end

  # ---------------------------------------------------------------------------
  # put_display_prefs/2 — validate + normalize + merge-preserve
  # ---------------------------------------------------------------------------

  describe "put_display_prefs/2 — round-trip" do
    test "persists all five prefs and reads them back" do
      user = user_fixture()

      body =
        valid_wire(%{
          "time_format" => "hm",
          "colored_nicklist" => true,
          "presence_filter" => %{"libera #bofh" => "hide", "libera #cat" => "show"}
        })

      assert {:ok, %Settings{}} = UserSettings.put_display_prefs({:user, user.id}, body)

      assert UserSettings.get_display_prefs({:user, user.id}) == %{
               time_format: "hm",
               colored_nicklist: true,
               presence_filter: %{"libera #bofh" => "hide", "libera #cat" => "show"},
               show_bottom_bar: true,
               strip_formatting: false,
               show_event_badge: false,
               bold_mentions: true
             }
    end

    test "accepts atom-keyed input too (parity with put_notification_prefs)" do
      user = user_fixture()

      assert {:ok, _} =
               UserSettings.put_display_prefs({:user, user.id}, %{
                 time_format: "hm",
                 colored_nicklist: true,
                 presence_filter: %{"n #a" => "show"}
               })

      got = UserSettings.get_display_prefs({:user, user.id})
      assert got.time_format == "hm"
      assert got.colored_nicklist == true
      assert got.presence_filter == %{"n #a" => "show"}
    end
  end

  describe "put_display_prefs/2 — tri-state invariant (NON-NEGOTIABLE)" do
    test "an unset channel stays ABSENT through the round-trip — never coerced" do
      user = user_fixture()

      # Only #a is pinned; #b is deliberately never mentioned (unset).
      body = valid_wire(%{"presence_filter" => %{"n #a" => "hide"}})
      assert {:ok, _} = UserSettings.put_display_prefs({:user, user.id}, body)

      pf = UserSettings.get_display_prefs({:user, user.id}).presence_filter

      # The pin round-trips as the exact string value — not a boolean, not a
      # third state.
      assert pf["n #a"] == "hide"
      # The unset channel is ABSENT, not present-as-false / present-as-"show".
      refute Map.has_key?(pf, "n #b")
      assert map_size(pf) == 1
    end

    test "an empty presence_filter round-trips as empty (all channels unset)" do
      user = user_fixture()
      assert {:ok, _} = UserSettings.put_display_prefs({:user, user.id}, valid_wire())
      assert UserSettings.get_display_prefs({:user, user.id}).presence_filter == %{}
    end

    test "clearing a pin (full-map PUT without it) returns that channel to unset" do
      user = user_fixture()

      {:ok, _} =
        UserSettings.put_display_prefs({:user, user.id}, valid_wire(%{"presence_filter" => %{"n #a" => "hide"}}))

      # Full-map PUT with #a omitted = "return #a to unset" (no PATCH/diff).
      {:ok, _} = UserSettings.put_display_prefs({:user, user.id}, valid_wire(%{"presence_filter" => %{}}))

      assert UserSettings.get_display_prefs({:user, user.id}).presence_filter == %{}
    end
  end

  describe "put_display_prefs/2 — validation" do
    test "rejects an unknown time_format (closed set)" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{} = cs} =
               UserSettings.put_display_prefs({:user, user.id}, valid_wire(%{"time_format" => "iso8601"}))

      assert cs.errors[:display_prefs]
    end

    test "rejects a non-boolean colored_nicklist" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.put_display_prefs({:user, user.id}, valid_wire(%{"colored_nicklist" => "yes"}))
    end

    test "rejects a presence value that is neither show nor hide" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.put_display_prefs(
                 {:user, user.id},
                 valid_wire(%{"presence_filter" => %{"n #a" => "maybe"}})
               )
    end

    test "rejects a presence value coerced from a boolean (no flattening on input either)" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.put_display_prefs(
                 {:user, user.id},
                 valid_wire(%{"presence_filter" => %{"n #a" => false}})
               )
    end

    test "rejects a presence_filter that is not a map" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.put_display_prefs({:user, user.id}, valid_wire(%{"presence_filter" => ["n #a"]}))
    end
  end

  describe "put_display_prefs/2 — merge-preserve (key isolation)" do
    test "writing display_prefs leaves notification_prefs + highlight_patterns intact" do
      user = user_fixture()
      subject = {:user, user.id}

      {:ok, _} = UserSettings.set_highlight_patterns(subject, ["watchme"])

      {:ok, _} =
        UserSettings.put_notification_prefs(subject, %{
          channel_messages_all: false,
          channel_messages_only: [],
          channel_mentions: true,
          private_messages_all: true,
          private_messages_only: [],
          presence_online: false,
          presence_offline: false
        })

      {:ok, _} = UserSettings.put_display_prefs(subject, valid_wire(%{"time_format" => "hm"}))

      # The sibling keys survive the display_prefs write.
      assert UserSettings.get_highlight_patterns(subject) == ["watchme"]
      assert UserSettings.get_notification_prefs(subject).channel_mentions == true
      assert UserSettings.get_display_prefs(subject).time_format == "hm"
    end

    test "writing another key leaves display_prefs intact" do
      user = user_fixture()
      subject = {:user, user.id}

      {:ok, _} = UserSettings.put_display_prefs(subject, valid_wire(%{"colored_nicklist" => true}))
      {:ok, _} = UserSettings.set_highlight_patterns(subject, ["later"])

      assert UserSettings.get_display_prefs(subject).colored_nicklist == true
    end
  end

  describe "put_display_prefs/2 — DOS bounds" do
    test "rejects a presence_filter with too many entries" do
      user = user_fixture()

      too_many =
        Map.new(1..2_001, fn i -> {"n #chan#{i}", "hide"} end)

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.put_display_prefs({:user, user.id}, valid_wire(%{"presence_filter" => too_many}))
    end

    test "rejects an over-long channel key" do
      user = user_fixture()
      long_key = "n #" <> String.duplicate("x", 300)

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.put_display_prefs(
                 {:user, user.id},
                 valid_wire(%{"presence_filter" => %{long_key => "hide"}})
               )
    end
  end

  # ---------------------------------------------------------------------------
  # show_bottom_bar (#1766) — the fourth key, and the one whose ARRIVAL is the
  # interesting case
  # ---------------------------------------------------------------------------
  #
  # The pref itself is an ordinary boolean; what needs pinning is the skew a
  # fourth key creates. `fetch_display_bool/2` — the validator every prior key
  # uses — 422s a key that is absent, so a cic bundle predating #1766 would have
  # every one of its PUTs rejected the moment the server grows this key: the
  # operator's time-format and nicklist toggles would silently stop persisting
  # until the tab reloads onto the new bundle. That window is real (the server
  # and the bundle deploy separately — `deploy-m42.sh` vs `--cic`), and the wire
  # contract already names the rule: an unknown-or-missing field is never fatal,
  # in BOTH directions. So absence takes the default; a value that IS sent still
  # has to be a boolean.

  describe "show_bottom_bar (#1766)" do
    test "defaults to true — the bar ships shown, this is an opt-OUT" do
      assert UserSettings.default_display_prefs().show_bottom_bar == true
      assert UserSettings.get_display_prefs({:user, Ecto.UUID.generate()}).show_bottom_bar == true
    end

    test "round-trips false" do
      user = user_fixture()

      assert {:ok, _} =
               UserSettings.put_display_prefs({:user, user.id}, valid_wire(%{"show_bottom_bar" => false}))

      assert UserSettings.get_display_prefs({:user, user.id}).show_bottom_bar == false
    end

    test "a PUT from a pre-#1766 client (three keys, no show_bottom_bar) is ACCEPTED" do
      user = user_fixture()
      legacy_body = Map.delete(valid_wire(), "show_bottom_bar")

      assert {:ok, _} = UserSettings.put_display_prefs({:user, user.id}, legacy_body)
      # …and the omission reads as the default, not as a crash and not as false.
      assert UserSettings.get_display_prefs({:user, user.id}).show_bottom_bar == true
    end

    test "rejects a non-boolean show_bottom_bar — absent is tolerated, garbage is not" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{} = cs} =
               UserSettings.put_display_prefs({:user, user.id}, valid_wire(%{"show_bottom_bar" => "yes"}))

      assert cs.errors[:display_prefs]
    end

    test "accepts an atom key too (parity with the sibling booleans)" do
      user = user_fixture()

      assert {:ok, _} =
               UserSettings.put_display_prefs({:user, user.id}, %{
                 time_format: "hms",
                 colored_nicklist: false,
                 presence_filter: %{},
                 show_bottom_bar: false
               })

      assert UserSettings.get_display_prefs({:user, user.id}).show_bottom_bar == false
    end

    test "a stored blob predating the key reads true, not false" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      settings
      |> Settings.changeset(%{
        data:
          Map.put(settings.data, "display_prefs", %{
            "time_format" => "hm",
            "colored_nicklist" => true,
            "presence_filter" => %{}
          })
      })
      |> Repo.update!()

      assert UserSettings.get_display_prefs({:user, user.id}).show_bottom_bar == true
    end
  end

  # ---------------------------------------------------------------------------
  # strip_formatting (#2029) — the FIFTH key, and the proof the fourth's
  # tolerance was a pattern rather than a one-off
  # ---------------------------------------------------------------------------
  #
  # Requested by `morph` (Azzurra staff) after a channel filled with heavily
  # coloured bot output: render incoming messages with the mIRC control codes
  # STRIPPED. Not `+c`, which is a channel-wide operator policy that REJECTS
  # the message and so costs the reader the text along with the colours.
  #
  # The pref is server-backed rather than a localStorage flag, on #1766's own
  # criterion: a per-DEVICE toggle is right when the complaint is about a
  # VIEWPORT (#914's `hide_next_active`), and wrong when it is about the
  # ACCOUNT. A channel full of coloured bot output is identical on the phone
  # and on the desktop, so this is the account axis — and its nearest
  # neighbour by shape, `colored_nicklist`, is synced for the same reason.
  #
  # `fetch_optional_display_bool/3` is what makes the fifth key free: #1766
  # wrote it for the fourth and said in as many words that the NEXT added key
  # would have to remember it too. This block is that key remembering.

  describe "strip_formatting (#2029)" do
    test "defaults to false — colours keep rendering as they do today" do
      assert UserSettings.default_display_prefs().strip_formatting == false

      assert UserSettings.get_display_prefs({:user, Ecto.UUID.generate()}).strip_formatting ==
               false
    end

    test "round-trips true" do
      user = user_fixture()

      assert {:ok, _} =
               UserSettings.put_display_prefs(
                 {:user, user.id},
                 valid_wire(%{"strip_formatting" => true})
               )

      assert UserSettings.get_display_prefs({:user, user.id}).strip_formatting == true
    end

    test "a PUT from a client predating the key is ACCEPTED, and reads as the default" do
      user = user_fixture()
      older_body = Map.delete(valid_wire(), "strip_formatting")

      assert {:ok, _} = UserSettings.put_display_prefs({:user, user.id}, older_body)
      assert UserSettings.get_display_prefs({:user, user.id}).strip_formatting == false
    end

    # The other half of the skew, and the one that would silently break the
    # PREVIOUS four keys: a bundle that predates this one sends four keys, and
    # a mandatory fifth would 422 its every display write — the operator's
    # time-format and nicklist toggles would quietly stop persisting.
    test "a four-key PUT still persists the keys it DID send" do
      user = user_fixture()

      older_body =
        Map.delete(
          valid_wire(%{"time_format" => "hm", "colored_nicklist" => true}),
          "strip_formatting"
        )

      assert {:ok, _} = UserSettings.put_display_prefs({:user, user.id}, older_body)

      prefs = UserSettings.get_display_prefs({:user, user.id})
      assert prefs.time_format == "hm"
      assert prefs.colored_nicklist == true
    end

    test "rejects a non-boolean strip_formatting — absent is tolerated, garbage is not" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{} = cs} =
               UserSettings.put_display_prefs(
                 {:user, user.id},
                 valid_wire(%{"strip_formatting" => "yes"})
               )

      assert cs.errors[:display_prefs]
    end

    test "accepts an atom key too (parity with the sibling booleans)" do
      user = user_fixture()

      assert {:ok, _} =
               UserSettings.put_display_prefs({:user, user.id}, %{
                 time_format: "hms",
                 colored_nicklist: false,
                 presence_filter: %{},
                 show_bottom_bar: true,
                 strip_formatting: true
               })

      assert UserSettings.get_display_prefs({:user, user.id}).strip_formatting == true
    end

    test "a stored blob predating the key reads false, not nil" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      settings
      |> Settings.changeset(%{
        data:
          Map.put(settings.data, "display_prefs", %{
            "time_format" => "hm",
            "colored_nicklist" => true,
            "presence_filter" => %{},
            "show_bottom_bar" => true
          })
      })
      |> Repo.update!()

      assert UserSettings.get_display_prefs({:user, user.id}).strip_formatting == false
    end
  end

  describe "put_display_prefs/2 — visitor parity" do
    test "works for visitor subjects" do
      visitor = visitor_fixture()
      subject = {:visitor, visitor.id}

      assert {:ok, _} =
               UserSettings.put_display_prefs(subject, valid_wire(%{"presence_filter" => %{"n #v" => "hide"}}))

      assert UserSettings.get_display_prefs(subject).presence_filter == %{"n #v" => "hide"}
    end
  end

  # ---------------------------------------------------------------------------
  # show_event_badge (#2037 B) — the SIXTH key, and the first whose default
  # TAKES something away
  # ---------------------------------------------------------------------------
  #
  # vjt's ruling on #2037: "dobbiamo avere due bucket: messaggi e !messaggi. i
  # !messaggi non sono interessanti e devono solo finire nell'opt-in badge."
  # So the faint events pill stops rendering unless the operator asks for it,
  # and OFF is therefore the default — unlike the other five, this default
  # changes what an existing operator sees on their next load.
  #
  # Server-backed on #1766's criterion, same as the fifth: "is my sidebar
  # cluttered with join/part counts" is a property of the ACCOUNT, identical on
  # the phone and the desktop, not of a viewport.
  #
  # ⚠️ The behaviour change this carries is NOT limited to join/part. The
  # events bucket is `kind not in @content_kinds`, which includes `topic`,
  # `kick` and `server_event` — the three that sit OUTSIDE
  # `suppressed_presence_kinds/0` on purpose (#458) because the pane still
  # renders them. Under this pref a KICK stops contributing to a badge by
  # default. That is deliberate and called out rather than discovered: a kick
  # that needs to stay loud belongs in the mention/severity channel (#267),
  # not smuggled back into the message bucket.

  describe "show_event_badge (#2037 B)" do
    test "defaults to FALSE — the events pill is opt-in, not opt-out" do
      assert UserSettings.default_display_prefs().show_event_badge == false

      assert UserSettings.get_display_prefs({:user, Ecto.UUID.generate()}).show_event_badge ==
               false
    end

    test "round-trips true" do
      user = user_fixture()

      assert {:ok, _} =
               UserSettings.put_display_prefs(
                 {:user, user.id},
                 valid_wire(%{"show_event_badge" => true})
               )

      assert UserSettings.get_display_prefs({:user, user.id}).show_event_badge == true
    end

    test "a PUT from a client predating the key is ACCEPTED, and reads as the default" do
      user = user_fixture()
      older_body = Map.delete(valid_wire(), "show_event_badge")

      assert {:ok, _} = UserSettings.put_display_prefs({:user, user.id}, older_body)
      assert UserSettings.get_display_prefs({:user, user.id}).show_event_badge == false
    end

    test "a five-key PUT still persists the keys it DID send" do
      user = user_fixture()

      older_body =
        Map.delete(
          valid_wire(%{"time_format" => "hm", "colored_nicklist" => true}),
          "show_event_badge"
        )

      assert {:ok, _} = UserSettings.put_display_prefs({:user, user.id}, older_body)

      prefs = UserSettings.get_display_prefs({:user, user.id})
      assert prefs.time_format == "hm"
      assert prefs.colored_nicklist == true
    end
  end

  # ---------------------------------------------------------------------------
  # bold_mentions (issue 2167) — the SEVENTH key, and the first OPT-OUT of
  # something currently visible
  # ---------------------------------------------------------------------------
  #
  # vjt's ruling on issue 2167: option A, scoped preferences — "così sono
  # accessibili a tutti". The ask was a free-form custom CSS block; that was
  # declined in BOTH forms (client-local and theme-payload), and cosmetic knobs
  # become first-class validated preferences instead. This is the first one.
  #
  # The default is TRUE, which is the inverse of #2037's: the bold exists
  # today, so leaving it on is the no-change default and the opt-out is the
  # choice. That inversion is the whole reason this key gets its own block —
  # every absent-key path has to land on `true` here, where its six
  # predecessors land on their own (mostly `false`) defaults.
  #
  # Server-backed on #1766's criterion, same as the fifth and sixth: "the bold
  # annoys me" is a property of the ACCOUNT — identical on a phone and on a
  # desktop — not of a viewport. Its nearest neighbour by shape,
  # `strip_formatting`, is synced for that same reason.
  #
  # ⚠️ The constraint the ruling attached: the bold is what distinguishes a
  # mention row from a watchlist-highlight row (which is deliberately NOT
  # bold), so turning it off must not collapse the two. That is a STYLESHEET
  # invariant and is pinned client-side by
  # `cicchetto/src/__tests__/mentionBoldDistinction.test.ts` — nothing the
  # server can assert.

  describe "bold_mentions (issue 2167)" do
    test "defaults to TRUE — the opt-out is a choice, not a default change" do
      assert UserSettings.default_display_prefs().bold_mentions == true

      assert UserSettings.get_display_prefs({:user, Ecto.UUID.generate()}).bold_mentions ==
               true
    end

    test "round-trips false" do
      user = user_fixture()

      assert {:ok, _} =
               UserSettings.put_display_prefs(
                 {:user, user.id},
                 valid_wire(%{"bold_mentions" => false})
               )

      assert UserSettings.get_display_prefs({:user, user.id}).bold_mentions == false
    end

    test "a PUT from a client predating the key is ACCEPTED, and reads as bold" do
      user = user_fixture()
      older_body = Map.delete(valid_wire(), "bold_mentions")

      assert {:ok, _} = UserSettings.put_display_prefs({:user, user.id}, older_body)
      assert UserSettings.get_display_prefs({:user, user.id}).bold_mentions == true
    end

    # The direction that matters for THIS key, and the one no sibling test
    # covers: a stored `false` must survive a read. With a default of `true`,
    # a merge that treated `false` as "missing" (an `||` where a boolean guard
    # belongs) would silently restore the bold on every load and the
    # preference would be unusable — visibly set in the drawer, gone on reload.
    test "a stored false SURVIVES the default merge (not treated as absent)" do
      user = user_fixture()

      assert {:ok, _} =
               UserSettings.put_display_prefs(
                 {:user, user.id},
                 valid_wire(%{"bold_mentions" => false})
               )

      # Read twice: the merge runs on every read, so a one-shot pass would not
      # prove the value is stable.
      assert UserSettings.get_display_prefs({:user, user.id}).bold_mentions == false
      assert UserSettings.get_display_prefs({:user, user.id}).bold_mentions == false
    end

    test "rejects a non-boolean with a field error, like its six siblings" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{} = cs} =
               UserSettings.put_display_prefs(
                 {:user, user.id},
                 valid_wire(%{"bold_mentions" => "yes"})
               )

      assert cs.errors[:display_prefs]
    end
  end
end
