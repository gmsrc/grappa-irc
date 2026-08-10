defmodule Grappa.IRC.LineSplitTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.IRC.{CTCP, LineSplit}

  # #246 — worst-case source prefix the RELAYING server prepends to our
  # outbound line before fanning it out to other channel members:
  #
  #     :nick!user@host PRIVMSG #channel :<body>\r\n
  #     └──── source prefix ────┘└── command/target ──┘  └ CRLF
  #
  # A client's OWN outbound omits the prefix, so a fragment can be ≤ linelen
  # on grappa's wire yet exceed linelen once relayed → the server truncates
  # the tail → the next fragment resumes past the cut → a silent byte hole.
  # The budget MUST reserve the WORST-CASE prefix (host/cloak grows between
  # messages; never budget against the live prefix). Ceilings are the
  # protocol maxima grappa validates its own identity against —
  # Grappa.IRC.Identifier @nick_regex (≤30, Azzurra NICKLEN=30) and
  # @ident_regex (≤10, common USERLEN) — plus the common ircd HOSTLEN 63
  # (covers cloaks + bracketed IPv6 literals). Restated here as an
  # INDEPENDENT statement of the on-wire worst case: the test builds the
  # actual relayed bytes and checks byte_size, rather than trusting the
  # splitter's own budget arithmetic.
  @wc_nick String.duplicate("n", 30)
  @wc_ident String.duplicate("u", 10)
  @wc_host String.duplicate("h", 63)
  @wc_source_prefix ":" <> @wc_nick <> "!" <> @wc_ident <> "@" <> @wc_host <> " "

  # The concrete worst-case relayed wire frame around a fragment body.
  defp worst_case_relayed_frame(target, fragment),
    do: @wc_source_prefix <> "PRIVMSG #{target} :" <> fragment <> "\r\n"

  defp single_grapheme?(s), do: match?([_], String.graphemes(s))

  # #1109 — the whitespace policy, ASSERTED rather than assumed: a
  # word-boundary break consumes exactly the one whitespace grapheme it
  # breaks on, and nothing else is ever lost. So the fragments TILE the
  # body: each one is the next literal run, and two consecutive fragments
  # are separated by at most a single whitespace grapheme.
  #
  # This replaces the byte-identical `IO.iodata_to_binary(fragments) ==
  # body` that guarded #246 before word breaks existed. It is not the
  # weaker statement it looks like: a lost letter, a duplicated run, a
  # reordering, or a gap of two characters all fail here, and the gap is
  # additionally required to BE whitespace. The only thing it newly
  # tolerates is precisely the policy — one consumed whitespace per break.
  defp assert_tiles(body, fragments) do
    leftover =
      Enum.reduce(fragments, body, fn fragment, rest ->
        rest = skip_consumed_whitespace(rest, fragment)

        assert String.starts_with?(rest, fragment)

        binary_part(rest, byte_size(fragment), byte_size(rest) - byte_size(fragment))
      end)

    assert leftover == ""
  end

  # Fixed-width words make a fixture arithmetic rather than luck: an
  # 8-byte word plus one space is a 9-byte stride, and 9 divides neither
  # the plain budget nor the CTCP one, so a byte-only cut lands strictly
  # INSIDE a word in both arms.
  defp numbered_words(count),
    do: for(i <- 1..count, do: "word" <> String.pad_leading(Integer.to_string(i), 4, "0"))

  # An oversized token is emitted in budget-sized byte pieces; spelled out
  # here so the expectation is a statement of the contract, not a mirror
  # of whatever the splitter happened to do.
  defp hard_cut_pieces(token, budget) do
    token
    |> String.graphemes()
    |> Enum.chunk_every(budget)
    |> Enum.map(&Enum.join/1)
  end

  # A break consumed a whitespace grapheme iff the remaining body does not
  # already start with this fragment. At most ONE may be skipped, and it
  # must be whitespace — that is the policy under test.
  defp skip_consumed_whitespace(rest, fragment) do
    if String.starts_with?(rest, fragment) do
      rest
    else
      case String.next_grapheme(rest) do
        {gap, tail} ->
          # The gap MUST be whitespace: that is the policy under test.
          assert String.trim(gap) == ""
          tail

        nil ->
          flunk("ran out of body before fragment #{inspect(fragment)}")
      end
    end
  end

  describe "#246: split budget reserves the worst-case relayed source prefix" do
    test "every fragment stays ≤ linelen once framed with the relayed prefix" do
      # 600 bytes of ASCII — the exact repro shape from issue #246.
      body = String.duplicate("ABCDEFGH IJKLMNOP QRSTUVWX YZ ", 20)
      assert byte_size(body) == 600
      target = "#channel"

      fragments = LineSplit.split_privmsg_body(body, target, 512)
      assert length(fragments) >= 2

      # The heart of the bug: each fragment, AS THE SERVER WILL RELAY IT,
      # must fit the wire limit. Pre-fix the splitter budgets only the
      # client→server framing, so the relayed frame overruns 512 here.
      for fragment <- fragments do
        assert byte_size(worst_case_relayed_frame(target, fragment)) <= 512
      end

      # And no bytes are lost or duplicated at the boundaries. This body
      # has spaces, so since #1109 the breaks land on them and consume
      # one each — the tiling check is the exact statement of that.
      assert_tiles(body, fragments)
    end

    test "reserves the prefix even for a body that fits the client-side frame" do
      # A body that is ≤ 512 on grappa's OWN wire (client omits the prefix)
      # but > 512 once the server prepends the worst-case source prefix MUST
      # still be split — otherwise the relayed line is truncated.
      target = "#c"
      client_overhead = byte_size("PRIVMSG #{target} :\r\n")
      # Sized to fit the client frame exactly but overflow the relayed frame.
      body = String.duplicate("x", 512 - client_overhead)
      assert byte_size("PRIVMSG #{target} :" <> body <> "\r\n") <= 512
      assert byte_size(worst_case_relayed_frame(target, body)) > 512

      fragments = LineSplit.split_privmsg_body(body, target, 512)
      assert length(fragments) >= 2

      for fragment <- fragments do
        assert byte_size(worst_case_relayed_frame(target, fragment)) <= 512
      end

      # This body is whitespace-free, so there is no boundary to consume:
      # byte-identical reconstruction still holds exactly, and asserting
      # the stronger form here is deliberate.
      assert IO.iodata_to_binary(fragments) == body
    end
  end

  describe "split_privmsg_body/3 basics" do
    test "returns [body] when body fits the relay-safe budget" do
      assert LineSplit.split_privmsg_body("hello", "#channel", 512) == ["hello"]
    end

    test "splits a body that exceeds the relay-safe budget" do
      body = String.duplicate("a", 800)
      target = "#c"
      fragments = LineSplit.split_privmsg_body(body, target, 512)
      assert length(fragments) >= 2

      for fragment <- fragments do
        assert byte_size(worst_case_relayed_frame(target, fragment)) <= 512
      end

      assert IO.iodata_to_binary(fragments) == body
    end

    test "preserves CTCP ACTION envelope on every relay-safe fragment" do
      target = "#c"
      inner = String.duplicate("b", 800)
      action = "\x01ACTION " <> inner <> "\x01"
      fragments = LineSplit.split_privmsg_body(action, target, 512)
      assert length(fragments) >= 2

      for fragment <- fragments do
        assert String.starts_with?(fragment, "\x01ACTION ")
        assert String.ends_with?(fragment, "\x01")
        assert byte_size(worst_case_relayed_frame(target, fragment)) <= 512
      end

      # The inner text round-trips: strip each fragment's envelope and
      # concatenate → the original inner payload, byte-identical.
      reconstructed =
        fragments
        |> Enum.map(fn f ->
          f |> String.replace_prefix("\x01ACTION ", "") |> String.replace_suffix("\x01", "")
        end)
        |> IO.iodata_to_binary()

      assert reconstructed == inner
    end

    test "splits on grapheme boundaries (UTF-8 safe)" do
      body = String.duplicate("🍕", 400)
      target = "#c"
      fragments = LineSplit.split_privmsg_body(body, target, 512)
      assert length(fragments) >= 2

      for fragment <- fragments do
        assert String.valid?(fragment)
        assert byte_size(worst_case_relayed_frame(target, fragment)) <= 512
      end

      assert IO.iodata_to_binary(fragments) == body
    end

    test "single grapheme larger than the budget is emitted as its own fragment" do
      # linelen chosen so 0 < budget < byte_size("🍕") (4): the guard must
      # emit the indivisible grapheme intact rather than drop or bisect it.
      # relay overhead for "#c" = 107 (source prefix) + 12 + 2 = 121.
      assert [fragment] = LineSplit.split_privmsg_body("🍕", "#c", 124)
      assert fragment == "🍕"
    end

    test "fast-path returns [body] when the relay budget is non-positive" do
      # linelen too small to fit even the worst-case framing → no useful
      # split is possible; return the body unchanged rather than loop.
      assert LineSplit.split_privmsg_body("hi", "#c", 16) == ["hi"]
    end
  end

  describe "#1109: breaks land on word boundaries, not mid-word" do
    test "a long run of words is cut at spaces, never through a word" do
      target = "#c"
      linelen = 512
      budget = linelen - LineSplit.relay_frame_overhead(target)
      words = numbered_words(100)
      body = Enum.join(words, " ")

      # Pre-state: prove the trap is real BEFORE asserting the escape. A
      # hard cut keeps bytes [0, budget); it bisects a word exactly when
      # neither the last byte kept nor the first byte dropped is a space.
      assert byte_size(body) > budget
      refute binary_part(body, budget - 1, 1) == " "
      refute binary_part(body, budget, 1) == " "

      fragments = LineSplit.split_privmsg_body(body, target, linelen)
      assert length(fragments) >= 2

      # The discriminating assertion: the word SEQUENCE survives intact. A
      # mid-word cut turns one word into two shorter ones, which fails
      # here on both the count and the values.
      assert Enum.flat_map(fragments, &String.split(&1, " ", trim: true)) == words

      # The #246 guarantee is untouched by the new break rule.
      for fragment <- fragments do
        assert byte_size(worst_case_relayed_frame(target, fragment)) <= linelen
      end

      assert_tiles(body, fragments)
    end

    test "a CTCP ACTION breaks on words too, envelope intact on every fragment" do
      target = "#c"
      linelen = 512
      words = numbered_words(100)
      inner = Enum.join(words, " ")
      action = "\x01ACTION " <> inner <> "\x01"

      fragments = LineSplit.split_privmsg_body(action, target, linelen)
      assert length(fragments) >= 2

      inners =
        Enum.map(fragments, fn f ->
          assert String.starts_with?(f, "\x01ACTION ")
          assert String.ends_with?(f, "\x01")
          assert byte_size(worst_case_relayed_frame(target, f)) <= linelen
          f |> String.replace_prefix("\x01ACTION ", "") |> String.replace_suffix("\x01", "")
        end)

      # Same discriminator as the plain arm, applied to the payload inside
      # the envelope: the envelope must not buy itself a mid-word cut.
      assert Enum.flat_map(inners, &String.split(&1, " ", trim: true)) == words

      assert_tiles(inner, inners)
    end

    test "a single token longer than the budget is hard-cut, never dropped or looped" do
      # The fallback the issue requires: a URL / base64 blob / CJK wall
      # has no whitespace to break on, so the byte cut still applies. This
      # arm is a REGRESSION guard — it passes before the change too.
      target = "#c"
      linelen = 512
      budget = linelen - LineSplit.relay_frame_overhead(target)
      body = String.duplicate("z", budget * 2 + 5)

      fragments = LineSplit.split_privmsg_body(body, target, linelen)

      assert length(fragments) == 3
      # No whitespace anywhere means nothing can be consumed: the
      # reconstruction stays byte-identical.
      assert IO.iodata_to_binary(fragments) == body

      for fragment <- fragments do
        assert byte_size(worst_case_relayed_frame(target, fragment)) <= linelen
      end
    end

    test "a word longer than the budget does not starve the words around it" do
      # The carry case: breaking at the last space leaves the oversized
      # token to be hard-cut on the next pass. Nothing may be lost and the
      # search may only ever SHRINK a fragment, never grow one.
      target = "#c"
      linelen = 512
      budget = linelen - LineSplit.relay_frame_overhead(target)
      giant = String.duplicate("Z", budget + 40)
      body = "alpha beta " <> giant <> " omega tail"

      fragments = LineSplit.split_privmsg_body(body, target, linelen)

      assert Enum.flat_map(fragments, &String.split(&1, " ", trim: true)) ==
               ["alpha", "beta"] ++ hard_cut_pieces(giant, budget) ++ ["omega", "tail"]

      for fragment <- fragments do
        assert byte_size(worst_case_relayed_frame(target, fragment)) <= linelen
      end

      assert_tiles(body, fragments)
    end
  end

  # #1108 — the budget cic needs in order to warn, BEFORE sending, that the
  # draft no longer fits one frame. The client may not re-derive it: the #246
  # worst-case ceilings are exactly the numbers that drift silently in the
  # byte-losing direction. So the server publishes ONE per-network scalar and
  # the client subtracts its own target's byte length — which is why these
  # tests pin the linearity AND pin the number against the splitter's actual
  # behaviour rather than against its internal arithmetic.
  describe "#1108: the per-frame body budget as a published number" do
    test "a body of exactly the budget is one fragment; one byte more is two" do
      target = "#sniffo"
      linelen = 512
      budget = LineSplit.frame_budget_base(linelen) - byte_size(target)

      # Space-free so the #1109 word-boundary preference has no boundary to
      # take: the fragment count is then a pure statement about the budget.
      assert [_] = LineSplit.split_privmsg_body(String.duplicate("a", budget), target, linelen)

      assert [_, _] =
               LineSplit.split_privmsg_body(String.duplicate("a", budget + 1), target, linelen)
    end

    property "base minus the target's own bytes IS the per-target budget" do
      check all(
              target <- string(:utf8, min_length: 1, max_length: 60),
              linelen <- integer(200..600)
            ) do
        assert LineSplit.frame_budget_base(linelen) - byte_size(target) ==
                 linelen - LineSplit.relay_frame_overhead(target)
      end
    end
  end

  describe "property: relay-safe, lossless, codepoint-whole splitting" do
    property "tiles the body, every fragment relay-safe + valid UTF-8" do
      check all(
              # Plain (non-CTCP) bodies only: a CTCP ACTION re-wraps its
              # `\x01ACTION …\x01` envelope on EVERY fragment, so its
              # fragments don't tile the input — that path has its own
              # inner-payload unit tests above. Filtering via the production
              # predicate keeps the tiling assertion below airtight (a random
              # :utf8 body would hit the CTCP branch only ~never, but never is
              # not "impossible").
              body <-
                filter(string(:utf8, min_length: 1, max_length: 800), &(not CTCP.action?(&1))),
              linelen <- integer(200..600)
            ) do
        target = "#test"
        fragments = LineSplit.split_privmsg_body(body, target, linelen)

        assert fragments != []

        # (a) lossless up to the DECLARED whitespace policy (#1109): a
        # word-boundary break consumes exactly the one whitespace grapheme
        # it breaks on, and nothing else is ever dropped, duplicated or
        # reordered. Written out rather than inferred, because "modulo the
        # whitespace policy" is only a guarantee if the policy is stated.
        assert_tiles(body, fragments)

        for fragment <- fragments do
          # (c) whole codepoints — a fragment is never a bisected multibyte
          # sequence.
          assert String.valid?(fragment)

          # (b) each fragment fits the WORST-CASE relayed frame, EXCEPT a
          # single indivisible grapheme that itself exceeds the budget
          # (emitted intact by contract).
          assert byte_size(worst_case_relayed_frame(target, fragment)) <= linelen or
                   single_grapheme?(fragment)
        end
      end
    end
  end
end
