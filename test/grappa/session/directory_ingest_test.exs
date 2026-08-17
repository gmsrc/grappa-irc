defmodule Grappa.Session.DirectoryIngestTest do
  @moduledoc """
  #1390 slice 2 — the channel-directory ETL, exercised WITHOUT a session.

  This file is the boundary claim made falsifiable. It runs `async: true`
  on plain `ExUnit.Case`: no `DataCase`, no Repo, no `Session.Server`, no
  fake ircd. Its sibling `directory_test.exs` needs all four (240 lines,
  `async: false`, 25 references to `start_server`/`IRCServer`) because
  before this extraction the parse / batch / throttle decisions were only
  reachable by booting a GenServer.

  If a later change re-entangles those decisions with the session process,
  this file stops compiling or stops being `async: true` — that is the
  point of it. It is not a mirror of the implementation: it asserts the
  decisions, and two of them are behaviour that a tidy-up would silently
  change (see the `abort/1` test).
  """

  use ExUnit.Case, async: true

  alias Grappa.Session.DirectoryIngest

  # Tunables pinned per-test rather than taken from config: the point is the
  # decision boundary, and a config-derived batch size would make the
  # assertions read as coincidence.
  defp ingest(opts) do
    DirectoryIngest.new(
      timeout_ms: Keyword.get(opts, :timeout_ms, 60_000),
      throttle_ms: Keyword.get(opts, :throttle_ms, 1_000),
      batch: Keyword.get(opts, :batch, 200)
    )
  end

  defp armed(opts, now) do
    opts |> ingest() |> DirectoryIngest.start(now, make_ref())
  end

  describe "parse_row/1" do
    test "a full RPL_LIST row yields name, topic and count" do
      assert {:ok, row} = DirectoryIngest.parse_row(["mynick", "#elixir", "42", "The topic"])
      assert row == %{name: "#elixir", topic: "The topic", user_count: 42}
    end

    test "a stripped upstream that omits the trailing topic yields a nil topic" do
      assert {:ok, row} = DirectoryIngest.parse_row(["mynick", "#elixir", "7"])
      assert row == %{name: "#elixir", topic: nil, user_count: 7}
    end

    test "a non-numeric user count coerces to 0 rather than crashing the ingest" do
      assert {:ok, %{user_count: 0}} = DirectoryIngest.parse_row(["mynick", "#x", "lots", "t"])
    end

    test "a shape we do not recognise is dropped" do
      assert :error = DirectoryIngest.parse_row(["mynick"])
      assert :error = DirectoryIngest.parse_row([])
    end
  end

  describe "start/3 and in_flight?/1" do
    test "a fresh ingest is not in flight, and starting arms it" do
      idle = ingest([])
      refute DirectoryIngest.in_flight?(idle)

      running = DirectoryIngest.start(idle, 0, make_ref())
      assert DirectoryIngest.in_flight?(running)
    end
  end

  describe "absorb/3 — the batch boundary" do
    test "rows below the batch size buffer without an ingest action" do
      run = armed([batch: 3], 0)

      {run, actions} = DirectoryIngest.absorb(run, row("#a"), 0)
      assert actions == []
      {_run, actions} = DirectoryIngest.absorb(run, row("#b"), 0)
      assert actions == []
    end

    test "reaching the batch size emits ONE ingest action carrying wire order" do
      run = armed([batch: 3], 0)

      {run, []} = DirectoryIngest.absorb(run, row("#a"), 0)
      {run, []} = DirectoryIngest.absorb(run, row("#b"), 0)
      {_run, actions} = DirectoryIngest.absorb(run, row("#c"), 0)

      assert [{:ingest, rows}] = actions
      assert Enum.map(rows, & &1.name) == ["#a", "#b", "#c"]
    end

    test "the running tally survives a flush — count is total, not buffer depth" do
      run = armed([batch: 2, throttle_ms: 0], 0)

      {run, _} = DirectoryIngest.absorb(run, row("#a"), 0)
      {run, _} = DirectoryIngest.absorb(run, row("#b"), 0)
      {_run, actions} = DirectoryIngest.absorb(run, row("#c"), 0)

      assert {:progress, 3} in actions
    end
  end

  describe "absorb/3 — the progress throttle" do
    test "no progress ping inside the throttle window" do
      run = armed([throttle_ms: 1_000], 0)

      {_run, actions} = DirectoryIngest.absorb(run, row("#a"), 999)
      refute Enum.any?(actions, &match?({:progress, _}, &1))
    end

    test "a ping once the window elapses, and the window then restarts" do
      run = armed([throttle_ms: 1_000], 0)

      {run, actions} = DirectoryIngest.absorb(run, row("#a"), 1_000)
      assert {:progress, 1} in actions

      {run, actions} = DirectoryIngest.absorb(run, row("#b"), 1_500)
      refute Enum.any?(actions, &match?({:progress, _}, &1))

      {_run, actions} = DirectoryIngest.absorb(run, row("#c"), 2_000)
      assert {:progress, 3} in actions
    end

    test "the flush is ordered BEFORE the progress ping it reports" do
      run = armed([batch: 1, throttle_ms: 0], 0)

      {_run, actions} = DirectoryIngest.absorb(run, row("#a"), 0)

      assert [{:ingest, _}, {:progress, 1}] = actions
    end
  end

  describe "finish/1" do
    test "flushes the tail in wire order, hands back the watchdog ref, and clears the run" do
      timer = make_ref()
      run = DirectoryIngest.start(ingest(batch: 100), 0, timer)

      {run, []} = DirectoryIngest.absorb(run, row("#a"), 0)
      {run, []} = DirectoryIngest.absorb(run, row("#b"), 0)

      assert {cleared, rows, ^timer} = DirectoryIngest.finish(run)
      assert Enum.map(rows, & &1.name) == ["#a", "#b"]
      refute DirectoryIngest.in_flight?(cleared)
    end

    test "an empty buffer flushes nothing — never round-trip an empty insert" do
      run = armed([], 0)

      assert {cleared, [], _timer} = DirectoryIngest.finish(run)
      refute DirectoryIngest.in_flight?(cleared)
    end
  end

  describe "abort/1 — the watchdog" do
    test "DROPS the buffered rows and hands back nothing to write" do
      # Behaviour pin, not tidiness. `handle_info(:directory_refresh_timeout,
      # ...)` wipes the tracker without flushing, so rows buffered since the
      # last batch are lost and `ChannelDirectory.finalize/2` never runs for
      # that refresh. A version that flushed on timeout would change the DB
      # on every truncated refresh. #1390 slice 2 preserves it deliberately.
      run = armed([batch: 100], 0)

      {run, []} = DirectoryIngest.absorb(run, row("#a"), 0)
      {run, []} = DirectoryIngest.absorb(run, row("#b"), 0)

      cleared = DirectoryIngest.abort(run)

      refute DirectoryIngest.in_flight?(cleared)
      assert {^cleared, [], nil} = DirectoryIngest.finish(cleared)
    end
  end

  defp row(name), do: %{name: name, topic: nil, user_count: 1}
end
