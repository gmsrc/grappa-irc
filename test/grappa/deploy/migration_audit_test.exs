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

      assert {:error, [duplicate]} = MigrationAudit.audit(statuses)
      assert duplicate.version == @collided
      assert duplicate.applied

      assert duplicate.files == [
               "20260810120000_add_mute_to_user_settings.exs",
               "20260810120000_add_peer_to_mutes.exs"
             ]
    end

    test "refuses a duplicate that is still pending, and says it is pending" do
      statuses = [{:down, @collided, "add_mute"}, {:down, @collided, "add_peer"}]

      assert {:error, [duplicate]} = MigrationAudit.audit(statuses)
      refute duplicate.applied
    end

    test "reports EVERY duplicated version, not just the first, oldest first" do
      statuses = [
        {:down, 20_260_811_130_000, "add_notes"},
        {:down, 20_260_811_130_000, "add_labels"},
        {:up, @collided, "add_mute"},
        {:up, @collided, "add_peer"}
      ]

      assert {:error, duplicates} = MigrationAudit.audit(statuses)
      assert Enum.map(duplicates, & &1.version) == [@collided, 20_260_811_130_000]
    end

    test "passes a clean set, reporting the applied and pending counts it observed" do
      statuses = [
        {:up, 20_260_425_000_000, "init"},
        {:up, 20_260_504_013_318, "tighten_session_client_id_format"},
        {:down, 20_260_811_130_000, "add_notes"}
      ]

      assert {:ok, %{applied: 2, pending: 1}} = MigrationAudit.audit(statuses)
    end

    test "passes an empty set — a fresh database is not a fault" do
      assert {:ok, %{applied: 0, pending: 0}} = MigrationAudit.audit([])
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
