defmodule Grappa.Push.PresencePayloadParityTest do
  @moduledoc """
  Cross-language drift gate for the `/notify` presence push payload (#378).

  The payload contract between `Grappa.Push.Payload` (server) and
  `cicchetto/src/lib/pushPayload.ts` (the service worker's narrower +
  deep-link parser) is hand-synced — there is no codegen gate over it, the
  way `scripts/check.sh` has one for `wireTypes.ts`. A hand-COPIED literal
  in a vitest file would not be a tripwire at all: change
  `build_presence/3` and the TS literal simply doesn't move.

  So both ports run against ONE shared fixture
  (`cicchetto/src/lib/presencePushPayloads.json`) — the technique
  `Grappa.Push.ShouldNotifyParityTest` already established for the notify
  predicate. THIS suite asserts the server EMITS each fixture payload
  byte-for-byte; the vitest `pushPayload.test.ts` asserts the SW ACCEPTS
  the same bytes and resolves the deep link. Change one side and the
  fixture has to move, which drags the other side's assertion with it.
  """
  use ExUnit.Case, async: true

  alias Grappa.Push.Payload

  @fixture_path Path.expand(
                  "../../../cicchetto/src/lib/presencePushPayloads.json",
                  __DIR__
                )
  @external_resource @fixture_path
  @fixture @fixture_path |> File.read!() |> Jason.decode!()

  # Literal atoms created at this module's compile time, not
  # `String.to_existing_atom/1` — the sibling parity suite's rationale:
  # that call races module load order when the file runs in isolation.
  @presences %{"online" => :online, "offline" => :offline}

  test "the shared fixture is non-empty (guards an accidental empty array)" do
    assert length(@fixture) >= 4
  end

  for testcase <- @fixture do
    test "build_presence/3 — #{testcase["name"]}" do
      c = unquote(Macro.escape(testcase))

      built =
        Payload.build_presence(
          c["nick"],
          Map.fetch!(@presences, c["presence"]),
          c["network_slug"]
        )

      # Atom-keyed server shape vs the JSON's string keys: compare through
      # the string projection so a NEW server key (or a dropped one) fails
      # here rather than silently shipping a field the SW never sees.
      assert Map.new(built, fn {k, v} -> {Atom.to_string(k), v} end) == c["payload"]
    end
  end
end
