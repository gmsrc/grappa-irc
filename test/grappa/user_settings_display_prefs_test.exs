defmodule Grappa.UserSettingsDisplayPrefsTest do
  @moduledoc """
  Context tests for the `display_prefs` accessor cluster (#449) on
  `Grappa.UserSettings` — server-backed display preferences so a single
  account converges its UI across devices (report: desktop toggle didn't
  reach the iOS PWA because the prefs were localStorage-only).

  The three prefs: `time_format` (`"hms" | "hm"`, #217), `colored_nicklist`
  (boolean, #443), and `presence_filter` (a per-channel tri-state map, #222).

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
        "presence_filter" => %{}
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
               presence_filter: %{}
             }
    end

    test "returns defaults when the row exists but has no display_prefs key" do
      user = user_fixture()
      # A different accessor populates the row without a display_prefs key.
      {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, ["foo"])

      assert UserSettings.get_display_prefs({:user, user.id}) == %{
               time_format: "hms",
               colored_nicklist: false,
               presence_filter: %{}
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
               presence_filter: %{}
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
               presence_filter: %{}
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
    test "persists all three prefs and reads them back" do
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
               presence_filter: %{"libera #bofh" => "hide", "libera #cat" => "show"}
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

  describe "put_display_prefs/2 — visitor parity" do
    test "works for visitor subjects" do
      visitor = visitor_fixture()
      subject = {:visitor, visitor.id}

      assert {:ok, _} =
               UserSettings.put_display_prefs(subject, valid_wire(%{"presence_filter" => %{"n #v" => "hide"}}))

      assert UserSettings.get_display_prefs(subject).presence_filter == %{"n #v" => "hide"}
    end
  end
end
