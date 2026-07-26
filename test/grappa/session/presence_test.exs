defmodule Grappa.Session.PresenceTest do
  @moduledoc """
  Tests for `Grappa.Session.Presence` (#247) — the pure MONITOR/WATCH
  command builder + the authoritative presence state map with
  baseline-vs-transition classification.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.Session.Presence

  describe "arm_commands/2" do
    test "MONITOR renders one comma-joined + line" do
      assert Presence.arm_commands({:monitor, 100}, ["Foo", "Bar", "baz"]) ==
               ["MONITOR + Foo,Bar,baz"]
    end

    test "WATCH renders one space-joined line with per-target + signs" do
      assert Presence.arm_commands({:watch, 128}, ["Foo", "Bar"]) == ["WATCH +Foo +Bar"]
    end

    test ":none and empty list render nothing" do
      assert Presence.arm_commands(:none, ["Foo"]) == []
      assert Presence.arm_commands({:monitor, 100}, []) == []
      assert Presence.arm_commands({:watch, :unlimited}, []) == []
    end

    property "every rendered line stays under the 512-byte IRC frame budget" do
      check all(
              nicks <-
                StreamData.list_of(
                  StreamData.string(:alphanumeric, min_length: 1, max_length: 30),
                  min_length: 1,
                  max_length: 200
                ),
              mechanism <- StreamData.member_of([{:monitor, 100}, {:watch, 128}])
            ) do
        for line <- Presence.arm_commands(mechanism, nicks) do
          assert byte_size(line) + 2 <= 512, "line over budget: #{byte_size(line)}"
        end
      end
    end

    property "chunked MONITOR lines cover every nick exactly once" do
      check all(
              nicks <-
                StreamData.uniq_list_of(
                  StreamData.string(:alphanumeric, min_length: 1, max_length: 30),
                  min_length: 1,
                  max_length: 200
                )
            ) do
        lines = Presence.arm_commands({:monitor, :unlimited}, nicks)
        rendered = Enum.flat_map(lines, fn "MONITOR + " <> targets -> String.split(targets, ",") end)

        assert rendered == nicks
      end
    end
  end

  describe "remove_commands/2" do
    test "MONITOR - / WATCH - shapes" do
      assert Presence.remove_commands({:monitor, 100}, ["Foo"]) == ["MONITOR - Foo"]
      assert Presence.remove_commands({:watch, 128}, ["Foo", "Bar"]) == ["WATCH -Foo -Bar"]
      assert Presence.remove_commands(:none, ["Foo"]) == []
    end
  end

  describe "seed/1 + apply_report/3" do
    test "seed folds keys and starts :unknown" do
      assert Presence.seed(["Foo[1]", "Bar"]) == %{"foo{1}" => :unknown, "bar" => :unknown}
    end

    test "first report on an :unknown entry is :initial (baseline, no toast)" do
      seeded = Presence.seed(["Foo"])

      assert {:changed, :initial, reported} = Presence.apply_report(seeded, "Foo", :online)
      assert reported == %{"foo" => :online}
    end

    test "a genuine flip is :transition (toast-eligible)" do
      seeded = Presence.seed(["Foo"])
      {:changed, :initial, online} = Presence.apply_report(seeded, "Foo", :online)

      assert {:changed, :transition, flipped} = Presence.apply_report(online, "foo", :offline)
      assert flipped == %{"foo" => :offline}
    end

    test "duplicate reports dedupe to :unchanged" do
      seeded = Presence.seed(["Foo"])
      {:changed, :initial, online} = Presence.apply_report(seeded, "Foo", :online)

      assert Presence.apply_report(online, "FOO", :online) == :unchanged
    end

    test "reports fold rfc1459 (Foo[1] report matches foo{1} entry)" do
      map = Presence.seed(["foo{1}"])
      assert {:changed, :initial, _} = Presence.apply_report(map, "Foo[1]", :online)
    end

    test "reports for untracked nicks are :unchanged — never invent entries" do
      map = Presence.seed(["Foo"])
      assert Presence.apply_report(map, "Stranger", :online) == :unchanged
    end
  end

  describe "track/2 + untrack/2" do
    test "track adds :unknown entries without clobbering known state" do
      seeded = Presence.seed(["Foo"])
      {:changed, :initial, online} = Presence.apply_report(seeded, "Foo", :online)

      tracked = Presence.track(online, ["FOO", "Bar"])
      assert tracked == %{"foo" => :online, "bar" => :unknown}
    end

    test "untrack drops fold-matched entries" do
      map = Presence.seed(["Foo[1]", "Bar"])
      assert Presence.untrack(map, ["foo{1}"]) == %{"bar" => :unknown}
    end
  end

  describe "forget/2 — peer NICK rename (#378)" do
    test "resets a tracked nick to :unknown, keeping it watched" do
      assert Presence.forget(%{"alice" => :online}, "alice") == %{"alice" => :unknown}
    end

    test "fold-matches the old nick (#121)" do
      assert Presence.forget(%{"alice{m}" => :online}, "Alice[m]") == %{"alice{m}" => :unknown}
    end

    test "leaves an unwatched nick alone — never invents an entry" do
      map = %{"alice" => :online}
      assert Presence.forget(map, "mallory") == map
    end

    test "the reset makes the rename's 601/731 classify :initial, so no push fires" do
      # THE point of forget/2. A watched nick renaming makes upstream emit
      # RPL_LOGOFF for the OLD nick; against :online that is a genuine
      # :transition and would push "alice is offline" for someone who only
      # renamed. After forget/2 the same report is a silent baseline.
      online = %{"alice" => :online}
      assert {:changed, :transition, _} = Presence.apply_report(online, "alice", :offline)

      forgotten = Presence.forget(online, "alice")

      assert {:changed, :initial, %{"alice" => :offline}} =
               Presence.apply_report(forgotten, "alice", :offline)
    end

    test "a stranger taking the freed nick also reads :initial, not a false 'online'" do
      forgotten = Presence.forget(%{"alice" => :online}, "alice")

      assert {:changed, :initial, %{"alice" => :online}} =
               Presence.apply_report(forgotten, "alice", :online)
    end
  end
end
