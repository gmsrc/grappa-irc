defmodule Grappa.Push.PayloadTest do
  @moduledoc """
  Push notifications cluster B4 (2026-05-14) — payload shape.

  Pure function under test — no DB, `async: true` safe.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.Push.Payload
  alias Grappa.Scrollback.Message

  defp msg(opts) do
    %Message{
      id: opts[:id] || 1,
      channel: opts[:channel],
      sender: opts[:sender] || "alice",
      body: Keyword.get(opts, :body, "hello"),
      kind: opts[:kind] || :privmsg,
      server_time: 1_700_000_000_000,
      dm_with: opts[:dm_with]
    }
  end

  # RFC 2812 `nickname` body characters, minus `:` — the grammar excludes it
  # and the tag separator relies on that exclusion (see the disjointness
  # property below).
  defp nick_gen do
    StreamData.string(
      [?a..?z, ?A..?Z, ?0..?9, ?[, ?], ?\\, ?^, ?_, ?{, ?|, ?}, ?-],
      min_length: 1,
      max_length: 12
    )
  end

  defp channel_gen, do: StreamData.map(nick_gen(), &("#" <> &1))

  defp slug_gen, do: StreamData.string([?a..?z, ?0..?9, ?-], min_length: 1, max_length: 10)

  describe "build/3 — channel message" do
    test "title is '<sender> in <channel>'" do
      payload = Payload.build(msg(channel: "#sniffo", sender: "alice", body: "hi"), "libera", "vjt")
      assert payload.title == "alice in #sniffo"
      assert payload.body == "hi"
    end

    test "tag = '<network_slug>:<channel>' for OS dedup" do
      payload = Payload.build(msg(channel: "#sniffo"), "libera", "vjt")
      assert payload.tag == "libera:#sniffo"
    end

    test "url percent-encodes channel #" do
      payload = Payload.build(msg(channel: "#sniffo"), "libera", "vjt")
      assert payload.url == "/?network=libera&channel=%23sniffo"
    end

    test "url percent-encodes UTF-8 channel names" do
      payload = Payload.build(msg(channel: "#café"), "libera", "vjt")
      assert payload.url == "/?network=libera&channel=%23caf%C3%A9"
    end

    test "url percent-encodes ampersand-prefixed channel" do
      payload = Payload.build(msg(channel: "&local"), "libera", "vjt")
      assert payload.url == "/?network=libera&channel=%26local"
    end
  end

  describe "build/3 — DM (channel == own_nick)" do
    test "title is just the sender nick" do
      payload =
        Payload.build(
          msg(channel: "vjt", sender: "alice", body: "ping", dm_with: "alice"),
          "libera",
          "vjt"
        )

      assert payload.title == "alice"
      assert payload.body == "ping"
    end

    test "tag = '<network_slug>:<sender>' (groups same-peer DMs)" do
      payload =
        Payload.build(msg(channel: "vjt", sender: "alice", dm_with: "alice"), "libera", "vjt")

      assert payload.tag == "libera:alice"
    end

    test "url deep-links to the peer nick (not own_nick)" do
      payload =
        Payload.build(msg(channel: "vjt", sender: "alice", dm_with: "alice"), "libera", "vjt")

      assert payload.url == "/?network=libera&channel=alice"
    end
  end

  describe "build/3 — degenerate inputs" do
    test "nil body becomes empty string (no crash)" do
      payload = Payload.build(msg(channel: "#sniffo", body: nil), "libera", "vjt")
      assert payload.body == ""
    end

    test "shape is always the four required atom keys" do
      payload = Payload.build(msg(channel: "#sniffo"), "libera", "vjt")
      assert Enum.sort(Map.keys(payload)) == [:body, :tag, :title, :url]
    end
  end

  describe "put_badge/2 — door #1 icon-badge stamp" do
    test "adds the :badge key, preserving the base payload" do
      base = Payload.build(msg(channel: "#sniffo", sender: "alice", body: "hi"), "libera", "vjt")
      stamped = Payload.put_badge(base, 7)

      assert stamped.badge == 7
      # base fields untouched
      assert stamped.title == base.title
      assert stamped.body == base.body
      assert stamped.tag == base.tag
      assert stamped.url == base.url
      assert Enum.sort(Map.keys(stamped)) == [:badge, :body, :tag, :title, :url]
    end

    test "a zero badge is still stamped explicitly (cleared state)" do
      base = Payload.build(msg(channel: "#sniffo"), "libera", "vjt")
      assert Payload.put_badge(base, 0).badge == 0
    end
  end

  # ---------------------------------------------------------------------------
  # build_presence/3 — /notify presence transitions (#378)
  # ---------------------------------------------------------------------------

  describe "build_presence/3" do
    test "an online transition reads '<nick> is online / on <network>'" do
      payload = Payload.build_presence("alice", :online, "azzurra")

      # LITERALS, not a re-derivation through the production builder:
      # asserting `payload.title == "#{nick} #{verb}"` would be a tautology
      # that survives any copy change. Same discipline as build/3 above.
      assert payload.title == "alice is online"
      assert payload.body == "on azzurra"
    end

    test "an offline transition spells the verb the in-app toast already spells" do
      # cic's `Toasts.tsx` renders "is online" / "went offline" for the SAME
      # event. One event, one spelling — the push follows the shipped copy
      # rather than inventing a second one ("is offline").
      payload = Payload.build_presence("alice", :offline, "azzurra")

      assert payload.title == "alice went offline"
      assert payload.body == "on azzurra"
    end

    test "the tag folds the nick, the title and url keep it raw" do
      payload = Payload.build_presence("Alice", :online, "libera")

      assert payload.tag == "libera:presence:alice"
      assert payload.title == "Alice is online"
      assert payload.url == "/?network=libera&channel=Alice"
    end

    test "brackets are NOT folded (CASEMAPPING=ascii) and percent-encode in the url" do
      payload = Payload.build_presence("Al[i]ce", :online, "libera")

      assert payload.tag == "libera:presence:al[i]ce"
      assert payload.url == "/?network=libera&channel=Al%5Bi%5Dce"
    end

    test "badge is OMITTED — a presence transition creates no unread message" do
      payload = Payload.build_presence("alice", :online, "azzurra")

      refute Map.has_key?(payload, :badge)
      assert Enum.sort(Map.keys(payload)) == [:body, :tag, :title, :url]
    end
  end

  describe "build_presence/3 — tag disjointness from message tags" do
    # The collision this guards is a function of the nick and channel
    # GRAMMARS, not of one example: a bare-nick presence tag would equal the
    # DM tag for the same nick, so alice's DM banner and alice's presence
    # banner would coalesce under one OS tag and overwrite each other. `:` is
    # excluded from both `nickname` and `chanstring` in RFC 2812, which is
    # WHY the `presence:` infix is safe — so generate over the grammars.
    property "a presence tag never equals a message tag on the same network" do
      check all(
              nick <- nick_gen(),
              slug <- slug_gen(),
              channel <- channel_gen()
            ) do
        presence_tag = Payload.build_presence(nick, :online, slug).tag

        dm = msg(channel: "vjt", sender: nick, dm_with: nick, body: "ping")
        chan = msg(channel: channel, sender: nick, body: "ping")

        refute presence_tag == Payload.build(dm, slug, "vjt").tag
        refute presence_tag == Payload.build(chan, slug, "vjt").tag
      end
    end
  end
end
