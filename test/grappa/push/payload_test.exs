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

  describe "build_presence/3 — #378 /notify presence transition" do
    test "online copy" do
      payload = Payload.build_presence("alice", :online, "azzurra")
      assert payload.title == "alice is online"
      assert payload.body == "on azzurra"
    end

    test "offline copy" do
      payload = Payload.build_presence("alice", :offline, "azzurra")
      assert payload.title == "alice is offline"
      assert payload.body == "on azzurra"
    end

    test "title preserves the upstream nick casing, tag folds it" do
      payload = Payload.build_presence("Alice", :online, "azzurra")
      assert payload.title == "Alice is online"
      assert payload.tag == "azzurra:presence:alice"
    end

    test "tag folds rfc1459 bracket chars so one identity gets one banner (#121)" do
      # bahamut folds [ ] \ ~ -> { } | ^ — both spellings are ONE identity.
      assert Payload.build_presence("alice[m]", :online, "azzurra").tag ==
               Payload.build_presence("alice{m}", :online, "azzurra").tag
    end

    test "online and offline share a tag so the newer banner replaces the stale one" do
      assert Payload.build_presence("alice", :online, "azzurra").tag ==
               Payload.build_presence("alice", :offline, "azzurra").tag
    end

    test "url deep-links the raw nick, which cic parses as a query window" do
      assert Payload.build_presence("alice", :online, "azzurra").url ==
               "/?network=azzurra&channel=alice"
    end

    test "url percent-encodes a non-ASCII nick" do
      assert Payload.build_presence("café", :online, "azzurra").url ==
               "/?network=azzurra&channel=caf%C3%A9"
    end

    test "omits :badge — a presence flip creates no unread message" do
      payload = Payload.build_presence("alice", :online, "azzurra")
      refute Map.has_key?(payload, :badge)
      assert Enum.sort(Map.keys(payload)) == [:body, :tag, :title, :url]
    end
  end

  describe "build_presence/3 tag disjointness — the coalescing hazard" do
    # A BARE-nick presence tag would equal the DM tag for that same nick, so
    # alice's DM banner and alice's presence banner would coalesce and
    # overwrite each other. The `presence:` infix prevents it, and `:` is
    # legal in neither `nickname` nor `chanstring` (RFC 2812) — so this is a
    # property of the grammars, not of one hand-picked example.
    property "never collides with a DM or channel message tag on the same network" do
      check all(
              nick <- nick_gen(),
              chan <- channel_gen(),
              slug <- slug_gen(),
              presence <- StreamData.member_of([:online, :offline])
            ) do
        presence_tag = Payload.build_presence(nick, presence, slug).tag

        # own_nick "vjt" makes channel: "vjt" the inbound-DM shape.
        refute presence_tag == Payload.build(msg(channel: "vjt", sender: nick), slug, "vjt").tag
        refute presence_tag == Payload.build(msg(channel: chan, sender: nick), slug, "vjt").tag
      end
    end
  end

  # RFC 2812 nickname: letter/special then letter/digit/special/-, where
  # `special` is the fold-relevant bracket set [ ] \ ` _ ^ { | }.
  defp nick_gen do
    StreamData.string(Enum.concat([?a..?z, ?A..?Z, ?0..?9, [?[, ?], ?\\, ?^, ?{, ?|, ?}, ?-]]),
      min_length: 1,
      max_length: 12
    )
  end

  @channel_chars Enum.concat([?a..?z, ?A..?Z, ?0..?9, [?-, ?_]])

  defp channel_gen do
    @channel_chars
    |> StreamData.string(min_length: 1, max_length: 12)
    |> StreamData.map(&("#" <> &1))
  end

  defp slug_gen do
    StreamData.string(Enum.concat([?a..?z, ?0..?9, [?-]]), min_length: 1, max_length: 10)
  end
end
