defmodule Grappa.IRC.IdentifierTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.IRC.Identifier

  describe "valid_nick?/1" do
    test "accepts RFC-shape nicks" do
      assert Identifier.valid_nick?("vjt")
      assert Identifier.valid_nick?("alice123")
      assert Identifier.valid_nick?("bob_underscore")
      assert Identifier.valid_nick?("user-with-dash")
      assert Identifier.valid_nick?("[bracket]")
      assert Identifier.valid_nick?("a")
    end

    test "rejects nicks starting with a digit" do
      refute Identifier.valid_nick?("1abc")
    end

    test "rejects nicks starting with a dash (RFC 2812 §2.3.1: dash is tail-only)" do
      # F2 (S29 carryover): pre-fix the leading-`-` first-char class
      # would round-trip `-foo` through Identifier validate but the
      # upstream rejects it (432 ERR_ERRONEUSNICKNAME) and the Session
      # restart-loops. Pin the rule here so it can't drift back.
      refute Identifier.valid_nick?("-foo")
      refute Identifier.valid_nick?("-")
      refute Identifier.valid_nick?("--double")
    end

    property "rejects any nick with a leading dash, regardless of tail" do
      # Total cap is 30 chars (1 leading + 29 trailing); cap `tail` at 29
      # so the property tests the leading-dash rule on otherwise-valid
      # inputs, not the length rule.
      check all(tail <- StreamData.string(:ascii, max_length: 29)) do
        refute Identifier.valid_nick?("-" <> tail)
      end
    end

    property "accepts a one-char nick for every legal first-char" do
      first_chars =
        Enum.concat([?A..?Z, ?a..?z, [?[, ?], ?\\, ?`, ?_, ?^, ?{, ?|, ?}]])

      check all(c <- StreamData.member_of(first_chars)) do
        assert Identifier.valid_nick?(<<c>>)
      end
    end

    test "rejects whitespace" do
      refute Identifier.valid_nick?("with space")
      refute Identifier.valid_nick?(" leading")
      refute Identifier.valid_nick?("trailing ")
    end

    test "rejects empty + nil + non-binary" do
      refute Identifier.valid_nick?("")
      refute Identifier.valid_nick?(nil)
      refute Identifier.valid_nick?(:atom)
    end

    test "rejects nicks longer than 30 chars" do
      refute Identifier.valid_nick?(String.duplicate("a", 31))
      assert Identifier.valid_nick?(String.duplicate("a", 30))
    end
  end

  describe "valid_channel?/1" do
    test "accepts # / & / + / ! prefixed channels" do
      assert Identifier.valid_channel?("#sniffo")
      assert Identifier.valid_channel?("&local")
      assert Identifier.valid_channel?("+modeless")
      assert Identifier.valid_channel?("!safe")
    end

    test "rejects channels without RFC prefix" do
      refute Identifier.valid_channel?("sniffo")
      refute Identifier.valid_channel?("@special")
    end

    test "rejects channels with space, comma, BELL" do
      refute Identifier.valid_channel?("#with space")
      refute Identifier.valid_channel?("#with,comma")
      refute Identifier.valid_channel?("#with\x07bell")
    end

    test "rejects empty / nil / lone prefix" do
      refute Identifier.valid_channel?("")
      refute Identifier.valid_channel?(nil)
      refute Identifier.valid_channel?("#")
    end
  end

  describe "sanitize_ident/1" do
    test "strips a single leading tilde (the identd-verified anti-spoof guard)" do
      # grappa runs no identd; the ircd tilde-prefixes unverified idents.
      # A user-supplied leading `~` must not be presented as identd-verified,
      # so strip it (vjt ruling B: sanitize off, don't reject).
      assert Identifier.sanitize_ident("~foo") == "foo"
      assert Identifier.sanitize_ident("~a") == "a"
    end

    test "strips only ONE leading tilde (residual tildes fail validation)" do
      # A second tilde is left in place so valid_ident?/1 rejects it —
      # stripping-all would silently accept `~~evil` as `evil`.
      assert Identifier.sanitize_ident("~~foo") == "~foo"
      refute Identifier.valid_ident?(Identifier.sanitize_ident("~~foo"))
    end

    test "leaves a tilde-free ident untouched" do
      assert Identifier.sanitize_ident("foo") == "foo"
      assert Identifier.sanitize_ident("a.b-c_1") == "a.b-c_1"
    end

    test "a bare tilde sanitizes to empty (then fails validation)" do
      assert Identifier.sanitize_ident("~") == ""
      refute Identifier.valid_ident?(Identifier.sanitize_ident("~"))
    end

    test "passes non-binary through unchanged (mirrors canonical_nick/1)" do
      assert Identifier.sanitize_ident(nil) == nil
      assert Identifier.sanitize_ident(:atom) == :atom
    end
  end

  describe "valid_ident?/1" do
    test "accepts RFC-user-charset idents up to 10 chars" do
      assert Identifier.valid_ident?("vjt")
      assert Identifier.valid_ident?("a")
      assert Identifier.valid_ident?("user_1")
      assert Identifier.valid_ident?("a.b-c_d")
      assert Identifier.valid_ident?("1digit")
      assert Identifier.valid_ident?(String.duplicate("a", 10))
    end

    test "rejects idents longer than 10 chars (vjt ruling B: USERLEN cap)" do
      refute Identifier.valid_ident?(String.duplicate("a", 11))
    end

    test "rejects a leading tilde (must be sanitized off upstream, not validated in)" do
      refute Identifier.valid_ident?("~foo")
    end

    test "rejects @ and whitespace (would split the USER wire token)" do
      refute Identifier.valid_ident?("foo@bar")
      refute Identifier.valid_ident?("with space")
      refute Identifier.valid_ident?(" leading")
      refute Identifier.valid_ident?("trailing ")
    end

    test "rejects a trailing newline / CR (PCRE `$` anchor footgun)" do
      # `$` in Elixir/PCRE matches BEFORE a trailing `\n`, so a `^...$`
      # regex would ACCEPT `grp\n` — letting a newline-terminated ident
      # reach the wire (CRLF injection). The regex uses `\A...\z` anchors
      # precisely to reject these. (The AuthFSM @line_bound_fields guard is
      # a second line of defense, but the shape validator must reject at
      # the boundary.)
      refute Identifier.valid_ident?("grp\n")
      refute Identifier.valid_ident?("grp\r")
      refute Identifier.valid_ident?("grp\r\n")
      refute Identifier.valid_ident?("\ngrp")
    end

    test "rejects empty / nil / non-binary" do
      refute Identifier.valid_ident?("")
      refute Identifier.valid_ident?(nil)
      refute Identifier.valid_ident?(:atom)
    end

    property "accepts any 1..10-length string over the allowed charset" do
      allowed = Enum.concat([?A..?Z, ?a..?z, ?0..?9, [?., ?_, ?-]])

      check all(chars <- StreamData.list_of(StreamData.member_of(allowed), min_length: 1, max_length: 10)) do
        assert Identifier.valid_ident?(List.to_string(chars))
      end
    end
  end

  describe "canonical_channel/1 (ASCII casemapping — GH #525)" do
    test "ASCII-downcases sigil-prefixed channel names" do
      assert Identifier.canonical_channel("#Chan") == "#chan"
      assert Identifier.canonical_channel("#CHAN") == "#chan"
      assert Identifier.canonical_channel("#cHaN") == "#chan"
      assert Identifier.canonical_channel("&LocalChan") == "&localchan"
      assert Identifier.canonical_channel("!Safe") == "!safe"
      assert Identifier.canonical_channel("+Modeless") == "+modeless"
    end

    test "does NOT fold bracket chars [ ] \\ ~ (bahamut is CASEMAPPING=ascii — #525)" do
      # #525: Azzurra advertises AND implements CASEMAPPING=ascii, so
      # `#chan[1]` and `#chan{1}` are DISTINCT channels to the ircd — the
      # fold must keep them apart (only A-Z folds). Reverses the #364
      # over-fold that merged the two into one window.
      assert Identifier.canonical_channel("#chan[1]") == "#chan[1]"
      assert Identifier.canonical_channel("#a\\b") == "#a\\b"
      assert Identifier.canonical_channel("&tilde~") == "&tilde~"
      assert Identifier.canonical_channel("#Foo[Bar]") == "#foo[bar]"
    end

    test "does NOT touch the fold targets { } | ^ (collision-free)" do
      assert Identifier.canonical_channel("#chan{1}") == "#chan{1}"
      assert Identifier.canonical_channel("#a|b") == "#a|b"
      assert Identifier.canonical_channel("&caret^") == "&caret^"
    end

    test "is ASCII-only — does NOT merge non-ASCII case variants (the ASCII fold is byte-level)" do
      # The old Unicode `String.downcase/1` folded É->é so `#CAFÉ` and
      # `#café` merged into one window — WRONG for bahamut, whose ASCII
      # casemapping leaves both distinct. the ASCII fold is byte-level: the
      # multibyte É (>= 0x80) passes through untouched.
      assert Identifier.canonical_channel("#café") == "#café"
      assert Identifier.canonical_channel("#CAFÉ") == "#cafÉ"
      refute Identifier.canonical_channel("#CAFÉ") == Identifier.canonical_channel("#café")
    end

    test "shares ONE fold primitive with canonical_nick/1 (sigils are fold-invariant)" do
      # #364: canonical_channel and canonical_nick MUST fold identically.
      # Sigils (# & ! +) are outside the fold set, so folding the whole
      # channel string equals sigil <> fold(body).
      for body <- ["Foo[Bar]", "CHAN", "a\\b", "tilde~", "café", "MiXeD{ok}"] do
        assert Identifier.canonical_channel("#" <> body) == "#" <> Identifier.canonical_nick(body)
      end
    end

    test "passes already-canonical channels through verbatim" do
      assert Identifier.canonical_channel("#chan") == "#chan"
      assert Identifier.canonical_channel("&local") == "&local"
    end

    test "leaves nicks unchanged (case is meaningful for display)" do
      assert Identifier.canonical_channel("Vjt") == "Vjt"
      assert Identifier.canonical_channel("CristoBOT") == "CristoBOT"
    end

    test "leaves the $server pseudo-channel marker unchanged" do
      assert Identifier.canonical_channel("$server") == "$server"
    end

    test "passes non-binary input through unchanged" do
      assert Identifier.canonical_channel(nil) == nil
      assert Identifier.canonical_channel(:atom) == :atom
    end

    test "is idempotent" do
      assert Identifier.canonical_channel(Identifier.canonical_channel("#Chan[1]")) == "#chan[1]"
    end

    property "folds any sigil-prefixed ASCII channel per ASCII casemapping, and is idempotent" do
      sigils = StreamData.member_of([?#, ?&, ?!, ?+])
      # Body bytes: printable ASCII incl. the bracket chars so the
      # non-fold of `[ ] \\ ~` is exercised. Channel-legality is
      # irrelevant here — comma/etc. are fold-invariant, so they pass
      # through both the implementation and the oracle identically (same
      # generator shape as the canonical_nick property below).
      body_bytes = StreamData.list_of(StreamData.integer(?!..?~), min_length: 1, max_length: 20)

      check all(sigil <- sigils, cs <- body_bytes) do
        input = <<sigil>> <> :binary.list_to_bin(cs)
        canon = Identifier.canonical_channel(input)

        # ASCII fold = downcase A-Z only. The generator is ASCII-only, so
        # String.downcase/1 (Unicode-aware) coincides with the byte-level
        # ASCII fold here — brackets are left untouched.
        expected = String.downcase(input)

        assert canon == expected
        # Round-trip stability.
        assert Identifier.canonical_channel(canon) == canon
      end
    end

    property "leaves any non-sigil input unchanged" do
      # First char anything that is NOT a channel sigil.
      first = StreamData.filter(StreamData.integer(?A..?z), &(&1 not in [?#, ?&, ?!, ?+]))
      tail = StreamData.string(:ascii, max_length: 15)

      check all(c <- first, t <- tail) do
        input = <<c>> <> t
        assert Identifier.canonical_channel(input) == input
      end
    end
  end

  describe "canonical_nick/1 (ASCII casemapping — GH #525)" do
    test "ASCII-downcases A-Z" do
      assert Identifier.canonical_nick("Mezmerize") == "mezmerize"
      assert Identifier.canonical_nick("MEZMERIZE") == "mezmerize"
      assert Identifier.canonical_nick("mezmerize") == "mezmerize"
    end

    test "does NOT fold bracket chars [ ] \\ ~ (bahamut is CASEMAPPING=ascii — #525)" do
      # #525: bahamut folds ONLY A-Z (CASEMAPPING=ascii). Two nicks
      # differing only in a bracket-vs-brace are DISTINCT to the ircd —
      # merging them is the #525 "ghost in the nicklist" bug.
      assert Identifier.canonical_nick("nick[1]") == "nick[1]"
      assert Identifier.canonical_nick("a\\b") == "a\\b"
      assert Identifier.canonical_nick("tilde~") == "tilde~"
      assert Identifier.canonical_nick("Foo[Bar]") == "foo[bar]"
    end

    test "does NOT touch the fold targets { } | ^ (collision-free)" do
      assert Identifier.canonical_nick("nick{1}") == "nick{1}"
      assert Identifier.canonical_nick("a|b") == "a|b"
      assert Identifier.canonical_nick("caret^") == "caret^"
    end

    test "is ASCII-only — leaves UTF-8 multibyte untouched (the ASCII fold is byte-level)" do
      # Unlike String.downcase/1, the ASCII fold does NOT fold non-ASCII; the
      # SQLite lower() backfill (ASCII-only) must match this exactly.
      assert Identifier.canonical_nick("Ä") == "Ä"
      assert Identifier.canonical_nick("café") == "café"
      assert Identifier.canonical_nick("Über") == "Über"
    end

    test "passes non-binary through (mirror canonical_channel/1)" do
      assert Identifier.canonical_nick(nil) == nil
      assert Identifier.canonical_nick(:atom) == :atom
    end

    test "is idempotent" do
      assert Identifier.canonical_nick(Identifier.canonical_nick("Foo[Bar]")) == "foo[bar]"
    end

    property "matches ASCII downcase (A-Z only) for any ASCII nick, and is idempotent" do
      bytes = StreamData.list_of(StreamData.integer(?!..?~), min_length: 1, max_length: 20)

      check all(cs <- bytes) do
        input = :binary.list_to_bin(cs)
        canon = Identifier.canonical_nick(input)
        assert Identifier.canonical_nick(canon) == canon

        # ASCII fold = downcase A-Z only; the generator is ASCII-only, so
        # String.downcase/1 coincides with the byte-level fold (brackets
        # `[ ] \\ ~` are left untouched, unlike the old rfc1459 fold).
        expected = String.downcase(input)

        assert canon == expected
      end
    end
  end

  describe "canonical_target/1 (shape-appropriate fold — GH #532 D)" do
    test "channel-shaped targets fold exactly like canonical_channel/1" do
      for name <- ["#Chan", "&Local", "!ABCDE", "+Modey", "#Chan[1]"] do
        assert Identifier.canonical_target(name) == Identifier.canonical_channel(name)
      end

      assert Identifier.canonical_target("#Chan") == "#chan"
    end

    test "nick-shaped targets fold like canonical_nick/1 — the D fix" do
      # A DM window is keyed by a NICK. `canonical_channel/1` is a no-op for
      # a nick (sigil-gated), so the write path used to store raw casing and
      # fork one window into N cursor rows. `canonical_target/1` routes a
      # nick through `canonical_nick/1` so the write key matches the
      # case-insensitive read key.
      assert Identifier.canonical_target("NickTemp") == Identifier.canonical_nick("NickTemp")
      assert Identifier.canonical_target("NickTemp") == "nicktemp"
    end

    test "nick shape is where it DIVERGES from canonical_channel/1" do
      # This divergence IS the bug D fixes: canonical_channel leaves a nick
      # untouched, canonical_target folds it.
      assert Identifier.canonical_channel("NickTemp") == "NickTemp"
      assert Identifier.canonical_target("NickTemp") == "nicktemp"
    end

    test "the $server pseudo-channel is stable (fold is a no-op)" do
      assert Identifier.canonical_target("$server") == "$server"
    end

    test "passes non-binary through" do
      assert Identifier.canonical_target(nil) == nil
      assert Identifier.canonical_target(:atom) == :atom
    end
  end

  describe "canonical_target/2 (network-aware KEY fold — #537)" do
    test "composes normalize_casemapping/2 then the ASCII canonical_target/1" do
      # The single network-aware KEY fold every INGRESS routes through:
      # normalize the national chars for the network, then ASCII-fold. It
      # equals the explicit two-step pipe.
      for {input, cm} <- [
            {"#Foo[1]", :rfc1459},
            {"#Foo[1]", :ascii},
            {"Nick[1]", :rfc1459_strict},
            {"#CHAN", :rfc1459}
          ] do
        assert Identifier.canonical_target(input, cm) ==
                 input |> Identifier.normalize_casemapping(cm) |> Identifier.canonical_target()
      end
    end

    test "on :ascii it is byte-identical to canonical_target/1 (all of prod)" do
      # Azzurra is CASEMAPPING=ascii: the network-aware fold degenerates to
      # the plain ASCII fold, so every ASCII network behaves exactly as pre-#537.
      for input <- ["#Chan", "#chan[1]", "NickTemp", "$server", "#café"] do
        assert Identifier.canonical_target(input, :ascii) == Identifier.canonical_target(input)
      end
    end

    test "two rfc1459 channel spellings converge to ONE key" do
      assert Identifier.canonical_target("#Foo[1]", :rfc1459) ==
               Identifier.canonical_target("#Foo{1}", :rfc1459)

      assert Identifier.canonical_target("#Foo[1]", :rfc1459) == "#foo{1}"
    end

    test "the SAME two spellings stay DISTINCT on :ascii (pins #525)" do
      refute Identifier.canonical_target("#Foo[1]", :ascii) ==
               Identifier.canonical_target("#Foo{1}", :ascii)
    end

    test "passes non-binary through for every casemapping" do
      for cm <- [:ascii, :rfc1459, :rfc1459_strict] do
        assert Identifier.canonical_target(nil, cm) == nil
        assert Identifier.canonical_target(:atom, cm) == :atom
      end
    end
  end

  describe "normalize_casemapping/2 (per-network national-char ingress fold — #537)" do
    test ":ascii is identity — the national chars are meaningful distinct bytes" do
      # bahamut/Azzurra is CASEMAPPING=ascii: `[ ] \\ ~` are ordinary
      # distinct bytes, never folded onto `{ } | ^`. normalize is a no-op;
      # the downstream canonical_target/1 does the A-Z fold. This is the
      # #525 posture — keeping `#foo[1]`/`#foo{1}` DISTINCT.
      for s <- ["#Chan[1]", "foo{1}", "a\\b", "tilde~", "caret^", "#CAFÉ"] do
        assert Identifier.normalize_casemapping(s, :ascii) == s
      end
    end

    test ":rfc1459 folds the national quartet [ ] \\ ~ -> { } | ^" do
      # RFC 2812 §2.2: {}|^ are the lowercase equivalents of []\~. solanum/
      # Libera advertise CASEMAPPING=rfc1459, so `#foo[1]` and `#foo{1}` are
      # ONE channel to the ircd; the ingress normaliser maps the national
      # chars onto their folded representative so the ASCII fold downstream
      # converges them.
      assert Identifier.normalize_casemapping("[", :rfc1459) == "{"
      assert Identifier.normalize_casemapping("]", :rfc1459) == "}"
      assert Identifier.normalize_casemapping("\\", :rfc1459) == "|"
      assert Identifier.normalize_casemapping("~", :rfc1459) == "^"
      assert Identifier.normalize_casemapping("#foo[1]\\~", :rfc1459) == "#foo{1}|^"
    end

    test ":rfc1459 leaves A-Z to the downstream ASCII fold (separation of concerns)" do
      # normalize handles ONLY the national chars; the A-Z fold is
      # canonical_target/1's job. Keeping them split lets the SQL twin
      # (plain lower()) stay byte-pinned to the A-Z fold, per the vjt ruling.
      assert Identifier.normalize_casemapping("Foo", :rfc1459) == "Foo"
      assert Identifier.normalize_casemapping("#CHAN", :rfc1459) == "#CHAN"
    end

    test ":rfc1459 leaves the fold TARGETS { } | ^ untouched (already lowercase)" do
      # {}|^ are the lowercase forms — the ircd never folds them further, so
      # `#foo~` and `#foo^` converge onto `#foo^` (idempotent under re-fold).
      assert Identifier.normalize_casemapping("{}|^", :rfc1459) == "{}|^"
    end

    test ":rfc1459_strict folds [ ] \\ but NOT ~ (RFC 1459 predates the tilde rule)" do
      assert Identifier.normalize_casemapping("[", :rfc1459_strict) == "{"
      assert Identifier.normalize_casemapping("]", :rfc1459_strict) == "}"
      assert Identifier.normalize_casemapping("\\", :rfc1459_strict) == "|"
      # tilde stays a tilde under strict — the strict fold omits it.
      assert Identifier.normalize_casemapping("~", :rfc1459_strict) == "~"
      assert Identifier.normalize_casemapping("#foo[1]~", :rfc1459_strict) == "#foo{1}~"
    end

    test "is byte-level — UTF-8 multibyte passes through every casemapping" do
      # `[ ] \\ ~` are all < 0x80 and never appear as UTF-8 continuation
      # bytes, so multibyte sequences are untouched (mirrors fold_ascii).
      for cm <- [:ascii, :rfc1459, :rfc1459_strict] do
        assert Identifier.normalize_casemapping("café", cm) == "café"
        assert Identifier.normalize_casemapping("Ä", cm) == "Ä"
      end
    end

    test "combined with canonical_target/1, two rfc1459 spellings converge to ONE key" do
      # The whole point of axis 2: on an rfc1459 network `#Foo[1]` and
      # `#Foo{1}` are ONE channel. normalize_casemapping maps the national
      # chars, canonical_target folds A-Z, and both spellings land on the
      # same storage/lookup key.
      key = fn s ->
        s |> Identifier.normalize_casemapping(:rfc1459) |> Identifier.canonical_target()
      end

      assert key.("#Foo[1]") == key.("#Foo{1}")
      assert key.("#Foo[1]") == "#foo{1}"
      # nick-shaped too — rfc1459 folds nicks and channels identically.
      assert key.("Nick[1]") == key.("Nick{1}")
    end

    test "on :ascii the same two spellings stay DISTINCT (pins #525)" do
      key = fn s ->
        s |> Identifier.normalize_casemapping(:ascii) |> Identifier.canonical_target()
      end

      refute key.("#Foo[1]") == key.("#Foo{1}")
      assert key.("#Foo[1]") == "#foo[1]"
    end

    test "passes non-binary through for every casemapping" do
      for cm <- [:ascii, :rfc1459, :rfc1459_strict] do
        assert Identifier.normalize_casemapping(nil, cm) == nil
        assert Identifier.normalize_casemapping(:atom, cm) == :atom
      end
    end

    property ":rfc1459 maps exactly the national quartet, is idempotent, and touches no other byte" do
      bytes = StreamData.list_of(StreamData.integer(?!..?~), min_length: 1, max_length: 20)

      check all(cs <- bytes) do
        input = :binary.list_to_bin(cs)
        out = Identifier.normalize_casemapping(input, :rfc1459)

        # Independent oracle: map the four national chars, leave the rest.
        expected =
          for <<c <- input>>, into: "" do
            case c do
              ?[ -> "{"
              ?] -> "}"
              ?\\ -> "|"
              ?~ -> "^"
              _ -> <<c>>
            end
          end

        assert out == expected
        # Idempotent: the targets {}|^ are never in the source set.
        assert Identifier.normalize_casemapping(out, :rfc1459) == out
      end
    end
  end

  describe "valid_network_slug?/1" do
    test "accepts lowercase alphanum + dash + underscore" do
      assert Identifier.valid_network_slug?("azzurra")
      assert Identifier.valid_network_slug?("net_1")
      assert Identifier.valid_network_slug?("foo-bar")
      assert Identifier.valid_network_slug?("a")
    end

    test "rejects uppercase" do
      refute Identifier.valid_network_slug?("Azzurra")
    end

    test "rejects path separators (would corrupt PubSub topics)" do
      refute Identifier.valid_network_slug?("foo/bar")
    end

    test "rejects whitespace + special chars" do
      refute Identifier.valid_network_slug?("foo bar")
      refute Identifier.valid_network_slug?("foo:bar")
      refute Identifier.valid_network_slug?("foo.bar")
    end

    test "rejects empty / nil" do
      refute Identifier.valid_network_slug?("")
      refute Identifier.valid_network_slug?(nil)
    end

    test "rejects > 32 chars" do
      refute Identifier.valid_network_slug?(String.duplicate("a", 33))
      assert Identifier.valid_network_slug?(String.duplicate("a", 32))
    end
  end

  describe "valid_host?/1" do
    test "accepts hostnames + IPs" do
      assert Identifier.valid_host?("irc.azzurra.chat")
      assert Identifier.valid_host?("192.168.1.1")
      assert Identifier.valid_host?("[::1]")
      assert Identifier.valid_host?("localhost")
    end

    test "rejects whitespace + control chars" do
      refute Identifier.valid_host?("with space")
      refute Identifier.valid_host?("foo\nbar")
      refute Identifier.valid_host?("foo\x00bar")
    end

    test "rejects empty / nil" do
      refute Identifier.valid_host?("")
      refute Identifier.valid_host?(nil)
    end
  end

  describe "valid_sender?/1" do
    test "accepts nicks" do
      assert Identifier.valid_sender?("vjt")
    end

    test "accepts server names (host shape)" do
      assert Identifier.valid_sender?("irc.azzurra.chat")
    end

    test "accepts the * prefix-less marker" do
      assert Identifier.valid_sender?("*")
    end

    test "accepts <bracketed> meta-sender markers (REST-originated etc.)" do
      assert Identifier.valid_sender?("<local>")
      assert Identifier.valid_sender?("<system>")
    end

    test "rejects empty / nil / whitespace" do
      refute Identifier.valid_sender?("")
      refute Identifier.valid_sender?(nil)
      refute Identifier.valid_sender?("with space")
    end
  end

  # UX-4 bucket G — IRC services-sender classifier. Closed allowlist
  # shared by Session.Server's outbound `service_target?` (PRIVMSG to
  # NickServ: wire-only, no scrollback) and EventRouter's inbound
  # routing (PRIVMSG / NOTICE from NickServ → `$server` window). The
  # allowlist intentionally rejects ops nicks like `Conserv` / `Reserv`
  # — bucket H/S4 closed the same misclassification class for outbound.
  describe "services_sender?/1" do
    test "accepts the eleven well-known services nicks (case-insensitive)" do
      for nick <-
            ~w(NickServ ChanServ MemoServ OperServ BotServ HostServ HelpServ RootServ SeenServ StatServ DebugServ) do
        assert Identifier.services_sender?(nick), "expected #{nick} to classify as services"
        assert Identifier.services_sender?(String.downcase(nick))
        assert Identifier.services_sender?(String.upcase(nick))
      end
    end

    test "rejects channel-sigil targets without inspecting the allowlist" do
      refute Identifier.services_sender?("#nickserv")
      refute Identifier.services_sender?("&chanserv")
      refute Identifier.services_sender?("+memoserv")
      refute Identifier.services_sender?("!operserv")
      # The classifier is sigil-aware even when the suffix matches —
      # ops sometimes set up `#dataserv` channels and PRIVMSGs to them
      # must NOT trigger the no-persist credential branch.
      refute Identifier.services_sender?("#dataserv")
    end

    test "rejects ops nicks that happen to end in 'serv' (bucket H regression guard)" do
      refute Identifier.services_sender?("Conserv")
      refute Identifier.services_sender?("Dataserv")
      refute Identifier.services_sender?("Reserv")
      refute Identifier.services_sender?("bobserv")
      refute Identifier.services_sender?("conserve")
    end

    test "rejects non-binary / empty input" do
      refute Identifier.services_sender?(nil)
      refute Identifier.services_sender?(:nickserv)
      refute Identifier.services_sender?("")
      refute Identifier.services_sender?(123)
    end

    property "any non-allowlist binary returns false" do
      # Generate binaries that explicitly do NOT match the allowlist
      # (case-insensitive). Property: services_sender?/1 is false for
      # every such input.
      # Mirrors the production `@services` allowlist exactly — keep in
      # lockstep with `Grappa.IRC.Identifier` (and the cic-side twin in
      # `cicchetto/src/lib/servicesSender.ts`). A divergence here makes
      # the property vacuously wrong for a generated allowlist member.
      allowlist =
        MapSet.new(
          ~w(nickserv chanserv memoserv operserv botserv hostserv helpserv rootserv seenserv statserv debugserv)
        )

      check all(s <- StreamData.string(:ascii, min_length: 1, max_length: 20)) do
        if String.downcase(s) in allowlist do
          assert Identifier.services_sender?(s)
        else
          # Channel-sigil prefixes always false; non-allowlist always false.
          refute Identifier.services_sender?(s)
        end
      end
    end
  end

  describe "safe_oper_token?/1 (#20 bundle)" do
    test "accepts non-empty single tokens with no whitespace or control bytes" do
      for s <- ~w(vjt admin-op s3cret hunter2 op_with_underscore) do
        assert Identifier.safe_oper_token?(s), "expected #{s} to pass"
      end
    end

    test "rejects empty string" do
      refute Identifier.safe_oper_token?("")
    end

    test "rejects strings containing space or tab" do
      refute Identifier.safe_oper_token?("vjt extra")
      refute Identifier.safe_oper_token?("admin\tname")
      refute Identifier.safe_oper_token?(" leading")
      refute Identifier.safe_oper_token?("trailing ")
    end

    test "rejects strings containing CR/LF/NUL (line-token superset)" do
      refute Identifier.safe_oper_token?("evil\r\nKILL")
      refute Identifier.safe_oper_token?("evil\nfoo")
      refute Identifier.safe_oper_token?("evil\rfoo")
      refute Identifier.safe_oper_token?("evil\x00foo")
    end

    test "rejects non-binary input" do
      refute Identifier.safe_oper_token?(nil)
      refute Identifier.safe_oper_token?(:atom)
      refute Identifier.safe_oper_token?(42)
    end
  end

  describe "member_prefix/1 (#25 grade-snapshot helper)" do
    test "returns the highest-precedence sigil (@ > % > +)" do
      assert Identifier.member_prefix(["@"]) == "@"
      assert Identifier.member_prefix(["%"]) == "%"
      assert Identifier.member_prefix(["+"]) == "+"
      assert Identifier.member_prefix(["+", "@"]) == "@"
      assert Identifier.member_prefix(["+", "%"]) == "%"
    end

    test "returns nil for a plain member (empty list)" do
      assert Identifier.member_prefix([]) == nil
    end

    test "returns nil for non-list input" do
      assert Identifier.member_prefix(nil) == nil
      assert Identifier.member_prefix("@") == nil
    end
  end

  describe "nick_fold_sql/1 — ASCII fold pin (#525)" do
    # #525 narrowed the server-wide fold from rfc1459 (A-Z + the four
    # bracket chars `[ ] \\ ~` → `{ } | ^`) to plain ASCII (A-Z only),
    # because Azzurra (bahamut) is CASEMAPPING=ascii. The fold SQL now
    # lives in two runtime sources (`nick_fold/1` fragment,
    # `nick_fold_sql/1`) plus the live folded-index migrations, which MUST
    # stay byte-identical or SQLite silently stops using the expression
    # indexes (the on-conflict target then quietly breaks). This block
    # pins them to one canonical string AND guards against a future
    # reintroduction of the rfc1459 fold.
    @canonical "lower(COL)"

    # The #525 re-fold migration — recreates every live folded index with
    # the ASCII `lower()` expression. Pinned by name so its up-path index
    # literals stay tied to nick_fold_sql/1.
    @refold_migration "priv/repo/migrations/20260729120000_refold_identifiers_ascii.exs"

    # Pre-#525 migrations legitimately embed the rfc1459 four-replace fold
    # (correct when written; #525 supersedes their LIVE indexes). The
    # re-fold migration's own down/0 restores the rfc1459 indexes as its
    # documented inverse, so it is allow-listed too. Anything NEWER than
    # the re-fold must NOT carry the rfc1459 literal.
    @rfc1459_marker "replace(replace(replace(replace(lower("

    test "nick_fold_sql/1 renders the canonical ASCII fold" do
      assert Identifier.nick_fold_sql("COL") == @canonical
      assert Identifier.nick_fold_sql("nick") == "lower(nick)"
      assert Identifier.nick_fold_sql("target_nick") == "lower(target_nick)"

      # #393 — the DM-peer covering index folds the COALESCE window key
      # `COALESCE(dm_with, channel)` (the SAME expression `list_archive/3`'s
      # GROUP BY uses). `nick_fold_sql/1` takes any column-expression, so the
      # folded-COALESCE index literal is single-sourced here too.
      assert Identifier.nick_fold_sql("COALESCE(dm_with, channel)") ==
               "lower(COALESCE(dm_with, channel))"
    end

    test "the #525 re-fold migration's up path embeds the ASCII fold from nick_fold_sql/1" do
      source = File.read!(@refold_migration)

      # Every live folded index the migration recreates, tied to the single
      # source so a fold change reddens here if the migration drifts.
      for col <- ["target_nick", "nick", "COALESCE(dm_with, channel)"] do
        assert String.contains?(source, Identifier.nick_fold_sql(col)),
               "#{@refold_migration} is missing #{Identifier.nick_fold_sql(col)}"
      end
    end

    test "no migration newer than the #525 re-fold reintroduces the rfc1459 fold" do
      # Lexicographic basename compare == chronological (YYYYMMDDHHMMSS
      # prefix). The re-fold migration and everything before it may carry
      # the rfc1459 literal (historical indexes / the re-fold's inverse
      # down/0); anything after must not.
      cutoff = Path.basename(@refold_migration)

      offenders =
        "priv/repo/migrations/*.exs"
        |> Path.wildcard()
        |> Enum.map(&Path.basename/1)
        |> Enum.filter(fn base ->
          base > cutoff and File.read!("priv/repo/migrations/#{base}") =~ @rfc1459_marker
        end)

      assert offenders == [],
             "these migrations reintroduce the rfc1459 fold after #525: #{inspect(offenders)}"
    end

    test "no lib/ module carries the rfc1459 fold literal (runtime folds via nick_fold*)" do
      # Post-#525 the fold is a trivial `lower()`; every runtime caller
      # derives it via nick_fold/1 / nick_fold_sql/1, and NO lib/ file —
      # not even Identifier itself — hand-writes the old rfc1459
      # four-replace form. Reintroducing it anywhere in lib/ reddens here.
      offenders =
        "lib/**/*.ex"
        |> Path.wildcard()
        |> Enum.filter(&(File.read!(&1) =~ @rfc1459_marker))

      assert offenders == [],
             "these lib/ modules carry the rfc1459 fold literal: #{inspect(offenders)}"
    end
  end
end
