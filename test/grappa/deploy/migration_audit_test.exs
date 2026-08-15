defmodule Grappa.Deploy.MigrationAuditTest do
  @moduledoc """
  The pure half of #1348: the rule that reads a merged
  `Ecto.Migrator.migrations/1` table and refuses a duplicated version.

  The regime under test is the one CLAUDE.md marks dangerous, and it is
  invisible to every count: when the duplicated version is ALREADY
  applied, both files leave the pending set, `ensure_no_duplication!([])`
  answers `:ok`, the migrate reports success, and neither file ever runs
  again. A gate that counts pending files sees zero — which is exactly
  what a healthy deploy also sees. So the input here is deliberately a
  set with NOTHING pending.
  """
  use ExUnit.Case, async: true

  alias Grappa.Deploy.MigrationAudit

  # The real collision that filed #1044 / #1038: two branches claiming
  # one version under different basenames, which git fuses silently.
  @collided 20_260_810_120_000

  describe "audit/1" do
    test "refuses an already-applied duplicate, with nothing pending" do
      # The two colliding rows arrive in DESCENDING name order, which is
      # what `Ecto.Migrator.migrations/1` actually hands over for an
      # applied pair (`pending_in_direction(_, _, :down)` reverses). The
      # refusal has to read the same either way, so the files come back
      # sorted rather than in arrival order.
      statuses = [
        {:up, 20_260_425_000_000, "init"},
        {:up, @collided, "add_peer_to_mutes"},
        {:up, @collided, "add_mute_to_user_settings"}
      ]

      disk = [20_260_425_000_000, @collided, @collided]

      assert {:error, [duplicate]} = MigrationAudit.audit(statuses, disk)
      assert duplicate.version == @collided
      assert duplicate.applied

      assert duplicate.files == [
               "20260810120000_add_mute_to_user_settings.exs",
               "20260810120000_add_peer_to_mutes.exs"
             ]
    end

    test "refuses a duplicate that is still pending, and says it is pending" do
      statuses = [{:down, @collided, "add_mute"}, {:down, @collided, "add_peer"}]

      assert {:error, [duplicate]} = MigrationAudit.audit(statuses, [@collided, @collided])
      refute duplicate.applied
    end

    test "reports EVERY duplicated version, not just the first, oldest first" do
      # The filler is not padding. `duplicates/1` groups by version, and an
      # Erlang map holds ≤32 keys as a flatmap, which enumerates in TERM
      # order — so a two-version input comes out ascending whether or not
      # anything sorted it, and the ordering claim would be bought by the
      # runtime rather than by the code. Past 32 keys the map is a hashmap
      # and enumeration order is unspecified. Production is ~86 migrations,
      # so this is also the realistic size.
      filler = for v <- 1..40, do: {:up, 20_250_000_000_000 + v, "filler_#{v}"}

      statuses =
        filler ++
          [
            {:down, 20_260_811_130_000, "add_notes"},
            {:down, 20_260_811_130_000, "add_labels"},
            {:up, @collided, "add_mute"},
            {:up, @collided, "add_peer"}
          ]

      disk = Enum.map(statuses, fn {_, version, _} -> version end)

      assert {:error, duplicates} = MigrationAudit.audit(statuses, disk)
      assert Enum.map(duplicates, & &1.version) == [@collided, 20_260_811_130_000]
    end

    test "passes a clean set, reporting the applied and pending counts it observed" do
      statuses = [
        {:up, 20_260_425_000_000, "init"},
        {:up, 20_260_504_013_318, "tighten_session_client_id_format"},
        {:down, 20_260_811_130_000, "add_notes"}
      ]

      disk = [20_260_425_000_000, 20_260_504_013_318, 20_260_811_130_000]

      assert {:ok, %{applied: 2, pending: 1, applied_without_file: []}} =
               MigrationAudit.audit(statuses, disk)
    end

    test "passes an empty set — a fresh database is not a fault" do
      assert {:ok, %{applied: 0, pending: 0, applied_without_file: []}} =
               MigrationAudit.audit([], [])
    end

    test "REPORTS a version applied with no file on disk, and does not refuse it" do
      # The case that cost two people an hour on 2026-08-15: a shared test
      # database carrying another branch's migration. `20260815210238` was
      # in `schema_migrations` with no file in this checkout, and nothing
      # said so — the symptom was three unrelated tests raising
      # Ecto.ConstraintError on an index no one here declared.
      #
      # It REPORTS rather than refuses because a database ahead of the code
      # is also a legitimate rollback, and a deploy from an older checkout.
      # Refusing there would block a valid operation at three doors.
      #
      # The name is deliberately Ecto's own placeholder, to show it is not
      # read: this is a set difference over versions, applied MINUS
      # on-disk, so nothing here depends on that literal.
      statuses = [
        {:up, 20_260_425_000_000, "init"},
        {:up, 20_260_815_210_238, "** FILE NOT FOUND **"},
        {:down, 20_260_811_130_000, "add_notes"}
      ]

      # `add_notes` is on disk and NOT applied — the opposite direction.
      # Subtracting the wrong way round would report it instead.
      disk = [20_260_425_000_000, 20_260_811_130_000]

      assert {:ok, summary} = MigrationAudit.audit(statuses, disk)
      assert summary.applied_without_file == [20_260_815_210_238]
    end
  end

  describe "describe/1" do
    test "names the version and BOTH files of every duplicate" do
      duplicates = [
        %{
          version: @collided,
          applied: true,
          files: ["20260810120000_add_mute.exs", "20260810120000_add_peer.exs"]
        }
      ]

      message = MigrationAudit.describe(duplicates)

      assert message =~ "20260810120000"
      assert message =~ "20260810120000_add_mute.exs"
      assert message =~ "20260810120000_add_peer.exs"
    end

    test "an applied duplicate says neither file will ever run" do
      applied = MigrationAudit.describe([%{version: @collided, applied: true, files: ["a", "b"]}])
      pending = MigrationAudit.describe([%{version: @collided, applied: false, files: ["a", "b"]}])

      assert applied =~ "already applied"
      refute pending =~ "already applied"
    end
  end
end
