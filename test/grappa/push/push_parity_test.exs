defmodule Grappa.Push.PushParityTest do
  @moduledoc """
  Drift gate for the #378 presence-push contract.

  The Web Push payload shape and `notification_prefs` cross a language
  boundary with NO codegen behind it: `scripts/check.sh`'s
  `mix grappa.gen_wire_types --check` covers `wireTypes.ts` only (PubSub /
  Channel shapes), and `notification_prefs` travels through
  `GrappaWeb.UserSettingsJSON` as an opaque pass-through map. The only
  thing tying `Grappa.Push.Payload` to `pushPayload.ts`, and
  `default_notification_prefs/0` to `DEFAULT_NOTIFICATION_PREFS`, is a
  comment.

  So both ports run against ONE fixture
  (`cicchetto/src/lib/pushParityFixture.json`): this suite asserts the
  SERVER produces it, and `pushParity.test.ts` asserts the CLIENT accepts
  it. Change either side → one suite goes red → update the fixture → the
  other suite picks it up. Same discipline as
  `should_notify_parity_test.exs`; here too ExUnit READS the cic-side
  artifact (the cic tree is bind-mounted into the test container).

  A hand-copied literal in the vitest test would NOT be a gate: if
  `build_presence/3` changed, a TS literal would not move and both suites
  would stay green.
  """
  use ExUnit.Case, async: true

  alias Grappa.Push.Payload
  alias Grappa.UserSettings

  @fixture_path Path.expand("../../../cicchetto/src/lib/pushParityFixture.json", __DIR__)
  @external_resource @fixture_path
  @fixture @fixture_path |> File.read!() |> Jason.decode!()

  @presences %{"online" => :online, "offline" => :offline}

  describe "notification_prefs defaults" do
    test "the shared fixture matches default_notification_prefs/0 exactly" do
      expected =
        Map.new(@fixture["notification_prefs_defaults"], fn {k, v} ->
          {String.to_existing_atom(k), v}
        end)

      assert UserSettings.default_notification_prefs() == expected
    end
  end

  describe "presence payloads" do
    for %{"why" => why} = c <- @fixture["presence_payloads"] do
      @case c
      test "build_presence/3 matches the fixture — #{why}" do
        %{
          "nick" => nick,
          "presence" => presence,
          "network_slug" => slug,
          "payload" => expected
        } = @case

        built = Payload.build_presence(nick, Map.fetch!(@presences, presence), slug)

        assert Map.new(built, fn {k, v} -> {Atom.to_string(k), v} end) == expected
      end
    end

    test "every fixture case deep-links a bare nick (so cic routes it to a query)" do
      for %{"payload" => payload, "expect_target" => target} <- @fixture["presence_payloads"] do
        assert target["kind"] == "query"

        # The url carries the RAW nick; cic folds it via canonicalQueryNick
        # when selecting. Assert the encoding round-trips to that raw nick.
        %URI{query: query} = URI.parse(payload["url"])
        assert URI.decode_query(query)["channel"] == target["channelName"]
      end
    end
  end
end
