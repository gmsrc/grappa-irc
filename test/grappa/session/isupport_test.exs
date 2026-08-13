defmodule Grappa.Session.ISupportTest do
  @moduledoc """
  Tests for `Grappa.Session.ISupport` — the per-network channel-mode
  capability table parsed from 005 RPL_ISUPPORT CHANMODES= + PREFIX=.

  Covers:
  - `default/0` — the pre-005 Bahamut/Azzurra seed (the values the
    hardcoded `@user_mode_prefixes` / `@channel_modes_with_param`
    constants used to carry).
  - `merge_isupport/2` — folds CHANMODES + PREFIX tokens off a 005
    param list into an existing capability table (unknown tokens
    ignored, absent tokens preserved).
  - `takes_param?/3` — whether a channel mode consumes an argument when
    applied with the given sign (RFC 2811 type A/B always; type C on +
    only; type D never).
  - `list_mode?/2` (#1249) — whether a channel mode is CHANMODES type A
    (a per-channel list: bans, exceptions), which the mode-set walkers
    must consume the param of but never record as a channel flag.
  - `user_prefix/2` — mode letter → sigil for per-user (membership)
    modes, or `:error` for channel-level modes.
  - `presence_mechanism/1` (#247) — MONITOR=/WATCH= token capture and
    the monitor-over-watch mechanism pick for the `/notify` arm.
  """
  use ExUnit.Case, async: true

  alias Grappa.Session.ISupport

  describe "default/0" do
    test "seeds the pre-005 Bahamut/Azzurra prefix + param tables" do
      d = ISupport.default()

      # PREFIX=(ohv)@%+ — the old @user_mode_prefixes constant.
      assert ISupport.user_prefix(d, "o") == {:ok, "@"}
      assert ISupport.user_prefix(d, "h") == {:ok, "%"}
      assert ISupport.user_prefix(d, "v") == {:ok, "+"}
      assert ISupport.user_prefix(d, "n") == :error

      # CHANMODES param modes — the old @channel_modes_with_param set
      # (b,e,I list-modes + k always-param + l set-only-param).
      for {mode, sign} <- [{"b", :add}, {"e", :add}, {"I", :add}, {"k", :add}] do
        assert ISupport.takes_param?(d, mode, sign),
               "expected #{mode} to take a param on +"
      end

      # l (type C) takes a param on + but NOT on -.
      assert ISupport.takes_param?(d, "l", :add)
      refute ISupport.takes_param?(d, "l", :remove)

      # Flag modes (type D) never take a param.
      for mode <- ["n", "t", "m", "s", "i", "p", "r"] do
        refute ISupport.takes_param?(d, mode, :add),
               "expected flag mode #{mode} to take no param"
      end
    end
  end

  describe "merge_isupport/2" do
    test "parses CHANMODES + PREFIX tokens from a 005 param list" do
      params = [
        "grappa-test",
        "CHANMODES=beI,k,l,imnpstrDdRcC",
        "PREFIX=(qaohv)~&@%+",
        "MODES=4",
        "are supported by this server"
      ]

      isupport = ISupport.merge_isupport(params, ISupport.default())

      # New PREFIX brings founder/admin sigils.
      assert ISupport.user_prefix(isupport, "q") == {:ok, "~"}
      assert ISupport.user_prefix(isupport, "a") == {:ok, "&"}
      assert ISupport.user_prefix(isupport, "o") == {:ok, "@"}
      assert ISupport.user_prefix(isupport, "v") == {:ok, "+"}

      # CHANMODES type A/B/C still take params; new type-D flags do not.
      assert ISupport.takes_param?(isupport, "b", :add)
      assert ISupport.takes_param?(isupport, "k", :add)
      assert ISupport.takes_param?(isupport, "l", :add)
      refute ISupport.takes_param?(isupport, "l", :remove)
      refute ISupport.takes_param?(isupport, "D", :add)
      refute ISupport.takes_param?(isupport, "R", :add)
    end

    test "preserves the current table when tokens are absent" do
      params = ["grappa-test", "NETWORK=Azzurra", "are supported by this server"]
      d = ISupport.default()

      assert ISupport.merge_isupport(params, d) == d
    end

    test "ignores a malformed CHANMODES token (wrong class count)" do
      # A CHANMODES with fewer than 4 comma-classes is malformed; keep
      # the prior table rather than corrupting param-arity classification.
      params = ["grappa-test", "CHANMODES=beI,k"]
      d = ISupport.default()

      assert ISupport.merge_isupport(params, d) == d
    end

    test "ignores a malformed PREFIX token (unbalanced modes/sigils)" do
      params = ["grappa-test", "PREFIX=(ohv)@%"]
      d = ISupport.default()

      assert ISupport.merge_isupport(params, d) == d
    end
  end

  # #1255 — the merge contract, pinned. Both docstrings (this module's
  # `merge_isupport/2` and the `Session.Server` 005 handler comment) used to
  # claim "only the first occurrence is honoured", and neither the reduce nor
  # any clause has ever implemented that: every clause writes unconditionally.
  # Last-wins is ALSO what draft-brocklesby-irc-isupport-03 §2 requires ("the
  # server should merely re-advertise the parameter with the new value"), so
  # the code was right and the prose was a spec violation on paper. These
  # tests are the executable form of the corrected contract — a future reader
  # tempted to add the "already set" guard the old docstring described has to
  # go through them.
  describe "merge_isupport/2 merge semantics (#1255)" do
    test "a token repeated within ONE 005 line honours the LAST occurrence" do
      params = [
        "grappa-test",
        "CHANMODES=beI,k,l,imnpst",
        "CHANMODES=b,k,l,imnpst",
        "are supported by this server"
      ]

      isupport = ISupport.merge_isupport(params, ISupport.default())

      # The SECOND advertisement narrowed type A to `b` alone: `e` and `I`
      # no longer take a param. A first-wins reduce would still classify
      # them as list modes.
      assert ISupport.takes_param?(isupport, "b", :add)
      refute ISupport.takes_param?(isupport, "e", :add)
      refute ISupport.takes_param?(isupport, "I", :add)
    end

    test "a re-advertisement on a LATER 005 line overwrites the earlier value" do
      # A 005 burst arrives in several lines, and the draft's stated way to
      # CHANGE a value is to re-advertise it — no negation required. Folding
      # line 2 onto the table line 1 produced must therefore take the new
      # value, not defend the old one.
      isupport =
        ISupport.default()
        |> then(&ISupport.merge_isupport(["grappa-test", "PREFIX=(ov)@+"], &1))
        |> then(&ISupport.merge_isupport(["grappa-test", "PREFIX=(qaohv)~&@%+"], &1))

      assert ISupport.user_prefix(isupport, "q") == {:ok, "~"}
      assert ISupport.user_prefix(isupport, "v") == {:ok, "+"}
    end
  end

  describe "takes_param?/3 type-C sign sensitivity" do
    test "type C consumes a param on + but not on -" do
      # l is the canonical type-C mode (+l 42 sets a limit; -l clears it
      # with no argument). A parser that consumes an arg on -l would
      # misalign the remaining args for a following param mode.
      d = ISupport.default()
      assert ISupport.takes_param?(d, "l", :add)
      refute ISupport.takes_param?(d, "l", :remove)
    end
  end

  # #1249 — CHANMODES type A is a per-channel LIST (bans, exceptions), not a
  # channel flag: the letter never belongs in the channel's mode set and an
  # ircd never reports it in 324 RPL_CHANNELMODEIS. `takes_param?/3` already
  # reads the same table for ARITY; this is the CLASS question, and the
  # walkers need it to drop the letter while still consuming its argument.
  describe "list_mode?/2 (#1249)" do
    test "the default table classifies b/e/I as list modes and flags as not" do
      d = ISupport.default()

      for mode <- ["b", "e", "I"] do
        assert ISupport.list_mode?(d, mode), "expected #{mode} to be a type-A list mode"
      end

      # Type B/C/D are channel state, not lists — including `k`, which takes
      # a param on both signs exactly like a type A does.
      for mode <- ["k", "l", "n", "t", "m", "s", "i"] do
        refute ISupport.list_mode?(d, mode), "expected #{mode} NOT to be a type-A list mode"
      end
    end

    test "the type-A letter set is per-network, read from the advertised CHANMODES" do
      # bahamut/Azzurra has no +e/+I and does have a `z` restrict list;
      # solanum advertises `q`. A hardcoded ["b","e","I"] would mis-class
      # both networks — the answer must come from the 005 table.
      bahamut =
        ISupport.merge_isupport(["s", "CHANMODES=bz,k,l,imnpst"], ISupport.default())

      assert ISupport.list_mode?(bahamut, "b")
      assert ISupport.list_mode?(bahamut, "z")
      refute ISupport.list_mode?(bahamut, "e")
      refute ISupport.list_mode?(bahamut, "I")

      solanum =
        ISupport.merge_isupport(["s", "CHANMODES=eIbq,k,flj,CFLMPQScgimnprstz"], ISupport.default())

      for mode <- ["e", "I", "b", "q"] do
        assert ISupport.list_mode?(solanum, mode)
      end

      refute ISupport.list_mode?(solanum, "z")
    end
  end

  # #218 — STATUSMSG is the ISUPPORT token listing which membership PREFIX
  # sigils may prefix a message target (`NOTICE @#chan`, `PRIVMSG +#chan`).
  # It's the source of truth for EventRouter's statusmsg-target strip, so
  # the set is network-advertised (bahamut/Azzurra: `@+`), never hardcoded.
  describe "STATUSMSG (#218)" do
    test "default/0 seeds the bahamut/Azzurra statusmsg sigils (@+)" do
      assert ISupport.statusmsg(ISupport.default()) == ["@", "+"]
      assert ISupport.default_statusmsg() == ["@", "+"]
    end

    test "merge_isupport/2 parses a STATUSMSG= token into the sigil list" do
      params = ["grappa-test", "STATUSMSG=@+", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.statusmsg(isupport) == ["@", "+"]
    end

    test "merge_isupport/2 honours a network that advertises a wider set (@%+)" do
      # A halfop-carrying network (`PREFIX=(ohv)@%+`) may advertise `%` as
      # a statusmsg level too — the set MUST come from the wire, not a
      # hardcoded `@+`.
      params = ["grappa-test", "STATUSMSG=@%+"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.statusmsg(isupport) == ["@", "%", "+"]
    end

    test "merge_isupport/2 preserves the current statusmsg when the token is absent" do
      params = ["grappa-test", "NETWORK=Azzurra", "are supported by this server"]
      d = ISupport.default()
      assert ISupport.statusmsg(ISupport.merge_isupport(params, d)) == ISupport.default_statusmsg()
    end

    test "merge_isupport/2 ignores an empty STATUSMSG= token" do
      # A server advertising `STATUSMSG=` with no sigils is malformed;
      # keep the prior set rather than blanking the strip capability.
      params = ["grappa-test", "STATUSMSG="]
      d = ISupport.default()
      assert ISupport.statusmsg(ISupport.merge_isupport(params, d)) == ISupport.default_statusmsg()
    end

    test "statusmsg/1 falls back to the default on a table predating the field (hot-reload safety)" do
      # A live Session.Server state seeded BEFORE this field existed holds
      # an isupport map without `:statusmsg`. A hot code-reload that reads
      # it must NOT KeyError — it defaults to the bahamut set, mirroring
      # the `Map.get(state, :isupport, ISupport.default())` pattern in
      # Session.Server. Cold restart reseeds the full default.
      pre_218 = Map.drop(ISupport.default(), [:statusmsg])
      refute Map.has_key?(pre_218, :statusmsg)
      assert ISupport.statusmsg(pre_218) == ISupport.default_statusmsg()
    end
  end

  # #537 — CASEMAPPING is the ISUPPORT token declaring how the ircd folds
  # identifiers (nicks AND channels): `ascii` (A-Z only — bahamut/Azzurra),
  # `rfc1459` (also folds `[ ] \` → `{ } |` and `~` → `^` — solanum/Libera),
  # `rfc1459-strict` (the bracket trio, NOT `~`). It's the source of truth
  # for the per-network ingress normaliser; an absent or unrecognised token
  # is treated as `ascii` (what #525 built for) so the rest of the server
  # can assume ASCII after the ingress door.
  describe "CASEMAPPING (#537)" do
    test "default/0 seeds :ascii (the absent-token default)" do
      assert ISupport.casemapping(ISupport.default()) == :ascii
    end

    test "merge_isupport/2 parses CASEMAPPING=ascii" do
      params = ["grappa-test", "CASEMAPPING=ascii", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.casemapping(isupport) == :ascii
    end

    test "merge_isupport/2 parses CASEMAPPING=rfc1459 (solanum/Libera)" do
      params = ["grappa-test", "CASEMAPPING=rfc1459", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.casemapping(isupport) == :rfc1459
    end

    test "merge_isupport/2 parses CASEMAPPING=rfc1459-strict" do
      params = ["grappa-test", "CASEMAPPING=rfc1459-strict"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.casemapping(isupport) == :rfc1459_strict
    end

    test "merge_isupport/2 falls back to :ascii + logs on an unrecognised value" do
      # A token value we don't model MUST NOT guess a fold table — it
      # degrades to :ascii (the safest: too-lax beats merging distinct
      # identities) and logs so the operator sees the unsupported network.
      import ExUnit.CaptureLog

      log =
        capture_log(fn ->
          isupport =
            ISupport.merge_isupport(["grappa-test", "CASEMAPPING=weird-9000"], ISupport.default())

          assert ISupport.casemapping(isupport) == :ascii
        end)

      assert log =~ "CASEMAPPING"
      assert log =~ "weird-9000"
    end

    test "merge_isupport/2 preserves the current casemapping when the token is absent" do
      params = ["grappa-test", "NETWORK=Azzurra", "are supported by this server"]
      rfc = ISupport.merge_isupport(["grappa-test", "CASEMAPPING=rfc1459"], ISupport.default())
      assert ISupport.casemapping(ISupport.merge_isupport(params, rfc)) == :rfc1459
    end

    test "casemapping/1 falls back to :ascii on a table predating the field (hot-reload safety)" do
      # A live Session.Server isupport map seeded before #537 has no
      # :casemapping key; a hot code-reload reading it must default to
      # :ascii, not KeyError. Mirrors statusmsg/1 + presence_mechanism/1.
      pre_537 = Map.drop(ISupport.default(), [:casemapping])
      refute Map.has_key?(pre_537, :casemapping)
      assert ISupport.casemapping(pre_537) == :ascii
    end
  end

  # #1255 — CHANTYPES is the ISUPPORT token listing the sigils that open a
  # CHANNEL name on this network. Everything in the stack open-codes the RFC
  # 2812 set `#&+!` (cic's compose/slashCommands/inviteLink/ScrollbackPane,
  # the server's `Identifier` channel regex), which is why the default IS
  # that set: a network that omits the token must behave exactly as before.
  describe "CHANTYPES (#1255)" do
    test "default/0 seeds the RFC 2812 sigil set the stack already assumes" do
      assert ISupport.chantypes(ISupport.default()) == ["#", "&", "+", "!"]
      assert ISupport.default_chantypes() == ["#", "&", "+", "!"]
    end

    test "merge_isupport/2 narrows to what the network advertises" do
      # bahamut/Azzurra advertises `#&`: `+foo` and `!foo` are NOT channels
      # there, and a client offering them is offering a JOIN that fails.
      params = ["grappa-test", "CHANTYPES=#&", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.chantypes(isupport) == ["#", "&"]
    end

    test "merge_isupport/2 ignores an empty CHANTYPES= token" do
      # A network with no channel sigils at all cannot be addressed; an
      # empty value is malformed, so keep the prior set rather than making
      # every channel name unrecognisable.
      d = ISupport.default()
      assert ISupport.chantypes(ISupport.merge_isupport(["grappa-test", "CHANTYPES="], d)) ==
               ISupport.default_chantypes()
    end

    test "chantypes/1 falls back to the default on a table predating the field" do
      pre_1255 = Map.drop(ISupport.default(), [:chantypes])
      refute Map.has_key?(pre_1255, :chantypes)
      assert ISupport.chantypes(pre_1255) == ISupport.default_chantypes()
    end
  end

  # #1255 — MAXLIST caps how many entries a type-A (list) mode holds. #1251
  # made every advertised list mode queryable from cic, so a client offering
  # a list needs the advertised cap. There is no honest default: pre-005 the
  # stack enforced no cap at all, and inventing one would reject an entry the
  # ircd would have accepted.
  describe "MAXLIST (#1255)" do
    test "default/0 advertises no caps" do
      assert ISupport.maxlist(ISupport.default()) == %{}
    end

    test "merge_isupport/2 parses a shared cap across a run of letters" do
      # `MAXLIST=beI:100` — ONE budget of 100 shared by b, e and I.
      params = ["grappa-test", "MAXLIST=beI:100", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.maxlist(isupport) == %{"b" => 100, "e" => 100, "I" => 100}
    end

    test "merge_isupport/2 parses per-letter caps" do
      params = ["grappa-test", "MAXLIST=b:60,e:60,I:50"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.maxlist(isupport) == %{"b" => 60, "e" => 60, "I" => 50}
    end

    test "merge_isupport/2 keeps the parseable entries and drops the malformed ones" do
      # A garbled entry must not cost the caps that parsed: dropping the
      # whole token would silently uncap every list the network DID declare.
      params = ["grappa-test", "MAXLIST=b:60,e:,:50,I:abc,q:0"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.maxlist(isupport) == %{"b" => 60}
    end

    test "merge_isupport/2 ignores a MAXLIST token with nothing parseable" do
      d = ISupport.default()
      seeded = ISupport.merge_isupport(["grappa-test", "MAXLIST=b:60"], d)
      assert ISupport.maxlist(ISupport.merge_isupport(["grappa-test", "MAXLIST=junk"], seeded)) ==
               %{"b" => 60}
    end

    test "maxlist/1 falls back to the empty map on a table predating the field" do
      pre_1255 = Map.drop(ISupport.default(), [:maxlist])
      assert ISupport.maxlist(pre_1255) == %{}
    end
  end

  # #1255 — the advertised length limits. `nil` (not a number) is the
  # pre-005 seed on purpose: today nothing validates length client-side, so
  # a guessed default would start REJECTING input the network accepts. Same
  # posture as #1108's `frame_budget_base` — no honest default, say nothing.
  describe "length limits (#1255)" do
    test "default/0 advertises no length limits" do
      d = ISupport.default()
      assert ISupport.nicklen(d) == nil
      assert ISupport.channellen(d) == nil
      assert ISupport.topiclen(d) == nil
    end

    test "merge_isupport/2 parses NICKLEN, CHANNELLEN and TOPICLEN" do
      params = [
        "grappa-test",
        "NICKLEN=30",
        "CHANNELLEN=200",
        "TOPICLEN=307",
        "are supported by this server"
      ]

      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.nicklen(isupport) == 30
      assert ISupport.channellen(isupport) == 200
      assert ISupport.topiclen(isupport) == 307
    end

    test "merge_isupport/2 ignores non-numeric and non-positive limits" do
      # `NICKLEN=0` would reject every nick; `TOPICLEN=abc` is noise. Keep
      # the prior value — an unusable cap is worse than no cap.
      seeded = ISupport.merge_isupport(["grappa-test", "NICKLEN=30"], ISupport.default())

      junk =
        ISupport.merge_isupport(
          ["grappa-test", "NICKLEN=0", "CHANNELLEN=abc", "TOPICLEN="],
          seeded
        )

      assert ISupport.nicklen(junk) == 30
      assert ISupport.channellen(junk) == nil
      assert ISupport.topiclen(junk) == nil
    end

    test "the limit accessors fall back to nil on a table predating the fields" do
      pre_1255 = Map.drop(ISupport.default(), [:nicklen, :channellen, :topiclen])
      assert ISupport.nicklen(pre_1255) == nil
      assert ISupport.channellen(pre_1255) == nil
      assert ISupport.topiclen(pre_1255) == nil
    end
  end

  describe "presence_mechanism/1 (#247)" do
    test "default/0 advertises no presence mechanism (:none pre-005)" do
      assert ISupport.presence_mechanism(ISupport.default()) == :none
    end

    test "MONITOR=<limit> yields {:monitor, limit}" do
      # solanum / Libera shape.
      params = ["grappa-test", "MONITOR=100", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.presence_mechanism(isupport) == {:monitor, 100}
    end

    test "bare MONITOR token yields {:monitor, :unlimited}" do
      params = ["grappa-test", "MONITOR", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.presence_mechanism(isupport) == {:monitor, :unlimited}
    end

    test "WATCH=<limit> yields {:watch, limit}" do
      # bahamut / Azzurra shape.
      params = ["grappa-test", "WATCH=128", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.presence_mechanism(isupport) == {:watch, 128}
    end

    test "MONITOR wins over WATCH when both are advertised" do
      # Whichever 005 line order the tokens arrive in, MONITOR (the
      # IRCv3 push mechanism) is preferred over legacy WATCH.
      params = ["grappa-test", "WATCH=128", "MONITOR=100"]
      one_line = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.presence_mechanism(one_line) == {:monitor, 100}

      # Reversed order across two merge passes (multi-line 005).
      two_lines =
        ISupport.default()
        |> then(&ISupport.merge_isupport(["grappa-test", "MONITOR=100"], &1))
        |> then(&ISupport.merge_isupport(["grappa-test", "WATCH=128"], &1))

      assert ISupport.presence_mechanism(two_lines) == {:monitor, 100}
    end

    test "malformed limit values fall back to :unlimited" do
      # `MONITOR=` (empty) and `WATCH=abc` (non-numeric) advertise the
      # mechanism without a parseable limit — arm it, don't reject it.
      empty_monitor = ISupport.merge_isupport(["grappa-test", "MONITOR="], ISupport.default())
      assert ISupport.presence_mechanism(empty_monitor) == {:monitor, :unlimited}

      alpha_watch = ISupport.merge_isupport(["grappa-test", "WATCH=abc"], ISupport.default())
      assert ISupport.presence_mechanism(alpha_watch) == {:watch, :unlimited}
    end

    test "presence_mechanism/1 is :none on a table predating the fields (hot-reload safety)" do
      # Same shape as the statusmsg/1 hot-safety: a live isupport map
      # seeded before #247 has no :monitor/:watch keys and must not
      # KeyError.
      pre_247 = Map.drop(ISupport.default(), [:monitor, :watch])
      assert ISupport.presence_mechanism(pre_247) == :none
    end

    test "WATCH token does not leak into an unrelated token prefix" do
      # `WATCHFOO=1` is NOT a WATCH advertisement.
      params = ["grappa-test", "WATCHFOO=1", "MONITORBAR=2"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.presence_mechanism(isupport) == :none
    end
  end
end
