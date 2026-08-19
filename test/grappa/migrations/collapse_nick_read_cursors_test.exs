defmodule Grappa.Migrations.CollapseNickReadCursorsTest do
  @moduledoc """
  GH #532 D — the nick-keyed `read_cursors` collapse migration
  (`20260729130000_collapse_nick_read_cursors`). Seeds the historical
  one-row-per-casing state a DM window accumulated (raw INSERT bypasses
  the now-folding changeset), runs the migration's exact SQL, and asserts:

    * duplicate nick rows collapse to ONE, KEEPING MAX(last_read_message_id)
      (NOT the newest-inserted row — the #532 stale-badge tie-break),
    * the surviving nick key is folded to canonical,
    * a lone mixed-case nick cursor is folded,
    * channel-shaped rows are left untouched (the channel fold migration's
      job, not this one),
    * the collapse is idempotent.

  The SQL is duplicated here (migrations stay self-contained per repo
  convention — see `SeedVisitorAutoconnectTest`). Keep it byte-aligned
  with the migration file.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Repo, ScrollbackHelpers}

  @nick_predicate "substr(channel,1,1) NOT IN ('#','&','!','+')"

  defp message(user, net, channel, st) do
    {:ok, m} =
      ScrollbackHelpers.insert(%{
        user_id: user.id,
        network_id: net.id,
        channel: channel,
        server_time: st,
        kind: :privmsg,
        sender: "vjt",
        body: "m"
      })

    m
  end

  # Raw INSERT bypasses `Cursor.changeset/2` (which now folds), so we can
  # stage the historical mixed-case rows the migration must repair.
  defp seed_cursor(user, net, channel, last_read_message_id) do
    ts = "2026-07-26T14:16:00.000000Z"

    Repo.query!(
      "INSERT INTO read_cursors (user_id, network_id, channel, last_read_message_id, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [user.id, net.id, channel, last_read_message_id, ts, ts]
    )
  end

  defp cursor_rows(user, net) do
    %{rows: rows} =
      Repo.query!(
        "SELECT channel, last_read_message_id FROM read_cursors WHERE user_id = ? AND network_id = ? ORDER BY channel",
        [user.id, net.id]
      )

    rows
  end

  # The migration's exact `up/0` SQL. Keep byte-aligned with
  # priv/repo/migrations/20260729130000_collapse_nick_read_cursors.exs.
  defp run_collapse do
    Repo.query!("""
    DELETE FROM read_cursors
    WHERE rowid NOT IN (
      SELECT rowid
      FROM read_cursors r1
      WHERE #{@nick_predicate}
        AND id = (
          SELECT id
          FROM read_cursors r2
          WHERE r2.network_id = r1.network_id
            AND COALESCE(r2.user_id, '') = COALESCE(r1.user_id, '')
            AND COALESCE(r2.visitor_id, '') = COALESCE(r1.visitor_id, '')
            AND lower(r2.channel) = lower(r1.channel)
            AND substr(r2.channel, 1, 1) NOT IN ('#', '&', '!', '+')
          ORDER BY r2.last_read_message_id DESC, r2.id DESC
          LIMIT 1
        )
    )
    AND #{@nick_predicate}
    """)

    Repo.query!("""
    UPDATE read_cursors
    SET channel = lower(channel)
    WHERE channel != lower(channel)
      AND #{@nick_predicate}
    """)
  end

  test "collapses duplicate nick cursors, KEEPS MAX(last_read_message_id), folds the key" do
    user = user_fixture()
    net = network_fixture()
    m_low = message(user, net, "NickTemp", 1)
    m_high = message(user, net, "NickTemp", 2)

    # The higher-read position is on the row inserted FIRST (lower id); the
    # newer row is parked behind. The migration must keep MAX read position,
    # not the newest row (keeping the older row is the exact #532 stale badge).
    seed_cursor(user, net, "NickTemp", m_high.id)
    seed_cursor(user, net, "nicktemp", m_low.id)

    run_collapse()

    assert [["nicktemp", lrmi]] = cursor_rows(user, net)
    assert lrmi == m_high.id
  end

  test "folds a lone mixed-case nick cursor with no duplicate" do
    user = user_fixture()
    net = network_fixture()
    m = message(user, net, "Solo", 1)

    seed_cursor(user, net, "Solo", m.id)
    run_collapse()

    assert [["solo", _]] = cursor_rows(user, net)
  end

  test "leaves channel-shaped cursors untouched (not this migration's scope)" do
    user = user_fixture()
    net = network_fixture()
    m = message(user, net, "#chan", 1)

    seed_cursor(user, net, "#Chan", m.id)
    run_collapse()

    assert [["#Chan", _]] = cursor_rows(user, net)
  end

  test "is idempotent — a second run is a no-op" do
    user = user_fixture()
    net = network_fixture()
    m_low = message(user, net, "NickTemp", 1)
    m_high = message(user, net, "NickTemp", 2)

    seed_cursor(user, net, "NickTemp", m_high.id)
    seed_cursor(user, net, "nicktemp", m_low.id)

    run_collapse()
    run_collapse()

    assert [["nicktemp", lrmi]] = cursor_rows(user, net)
    assert lrmi == m_high.id
  end
end
