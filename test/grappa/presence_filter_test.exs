defmodule Grappa.PresenceFilterTest do
  use ExUnit.Case, async: true

  alias Grappa.PresenceFilter
  alias Grappa.Scrollback.Message

  # #458 — the server-side twin of cic's `resolvePresenceVisible`
  # (`cicchetto/src/lib/presenceFilter.ts`), INVERTED: cic asks "is presence
  # VISIBLE?", the server asks "should the fetch HIDE presence?". An explicit
  # per-channel pref wins; unset follows the live member-count size default
  # against the shared `LARGE_CHANNEL_THRESHOLD`.
  describe "hidden?/2 — presence-hide decision (mirror of resolvePresenceVisible, inverted)" do
    test "explicit \"hide\" hides regardless of member count" do
      assert PresenceFilter.hidden?("hide", 0)
      assert PresenceFilter.hidden?("hide", 10_000)
      assert PresenceFilter.hidden?("hide", nil)
    end

    test "explicit \"show\" shows regardless of member count" do
      refute PresenceFilter.hidden?("show", 0)
      refute PresenceFilter.hidden?("show", 10_000)
      refute PresenceFilter.hidden?("show", nil)
    end

    test "unset follows the size default: hides at or above the threshold" do
      threshold = PresenceFilter.large_channel_threshold()
      assert PresenceFilter.hidden?(nil, threshold)
      assert PresenceFilter.hidden?(nil, threshold + 1)
    end

    test "unset follows the size default: shows below the threshold" do
      threshold = PresenceFilter.large_channel_threshold()
      refute PresenceFilter.hidden?(nil, threshold - 1)
      refute PresenceFilter.hidden?(nil, 0)
    end

    test "unset with an unavailable member count defaults to show (decision D — never hide on a guess)" do
      refute PresenceFilter.hidden?(nil, nil)
    end
  end

  # #915 — the cutoff exists TWICE, once per language, and until now the ONLY
  # thing holding the two equal was a sentence in each moduledoc. Every test on
  # both sides derives from its own constant, so raising one alone leaves both
  # suites fully green while the server omits presence from the REST history
  # page and cic renders it on the live tail — for every channel sized between
  # the two values, silently. Same executable-drift-guard shape as
  # `GrappaWeb.RouterSwDenylistTest` (which parses `service-worker.ts`) and the
  # `should_notify_parity_test.exs` shared truth table: the rule is expressed
  # once per language, so the EQUALITY has to be expressed as code.
  describe "cross-language threshold parity (#915)" do
    @cic_path "cicchetto/src/lib/presenceFilter.ts"

    test "@large_channel_threshold equals cic's LARGE_CHANNEL_THRESHOLD" do
      source = File.read!(@cic_path)

      cic_value =
        case Regex.run(~r/export\s+const\s+LARGE_CHANNEL_THRESHOLD\s*=\s*(\d+)\s*;/, source) do
          [_, digits] -> String.to_integer(digits)
          _ -> flunk("Could not locate `export const LARGE_CHANNEL_THRESHOLD = <n>;` in #{@cic_path}")
        end

      assert cic_value == PresenceFilter.large_channel_threshold(),
             """
             The denoise size-default cutoff has drifted between the two languages.

               #{@cic_path}: #{cic_value}
               Grappa.PresenceFilter:            #{PresenceFilter.large_channel_threshold()}

             They MUST be equal (#458 gave the render-layer rule a server twin for
             the REST history fetch). While they differ, every channel whose member
             count falls between the two values shows join/part/quit on the live WS
             tail and loses it on page-up. Move BOTH or neither.
             """
    end

    # #1262 — the threshold was not the only thing held equal by prose. The
    # KIND SET exists twice too (`Message.suppressed_presence_kinds/0` and
    # cic's `SUPPRESSED_PRESENCE_KINDS`), and adding `:mode` to one side alone
    # leaves BOTH suites green while the REST history page folds a mode row
    # the live WS tail still renders. Same executable-drift-guard shape as the
    # threshold test above: the rule is expressed once per language, so the
    # EQUALITY has to be expressed as code. Order is asserted too — both sides
    # document the mirror order, and a set-only compare would let the two
    # documented orders diverge silently.
    test "suppressed_presence_kinds/0 equals cic's SUPPRESSED_PRESENCE_KINDS, in order" do
      source = File.read!(@cic_path)

      body =
        case Regex.run(
               ~r/export\s+const\s+SUPPRESSED_PRESENCE_KINDS[^=]*=\s*new\s+Set\(\[(.*?)\]\)/s,
               source
             ) do
          [_, captured] ->
            captured

          _ ->
            flunk("Could not locate `export const SUPPRESSED_PRESENCE_KINDS = new Set([...])` in #{@cic_path}")
        end

      cic_kinds =
        ~r/"([a-z_]+)"/
        |> Regex.scan(body)
        |> Enum.map(fn [_, kind] -> String.to_atom(kind) end)

      # A drift guard that reads its subject out of ANOTHER language's source
      # has one failure mode worse than being wrong: becoming a no-op. If a
      # reformat, a quoting-style change, or a rename makes the parse yield
      # NOTHING, the comparison below must not quietly degrade into a
      # confusing `[] != [...]`. Assert the parse produced something FIRST, so
      # the failure names the real cause — the gate stopped reading the file.
      refute cic_kinds == [],
             """
             Parsed ZERO kinds out of #{@cic_path}.

             The literal was located but no `"kind"` strings came out of it,
             so this parity gate is no longer reading anything and would pass
             vacuously the moment the two sides agreed on emptiness. Fix the
             parse (quoting style? the array inlined or reformatted?) rather
             than the assertion.
             """

      assert cic_kinds == Message.suppressed_presence_kinds(),
             """
             The denoise KIND SET has drifted between the two languages.

               #{@cic_path}: #{inspect(cic_kinds)}
               Grappa.Scrollback.Message:        #{inspect(Message.suppressed_presence_kinds())}

             They MUST be equal AND in the same order: the server omits these
             kinds from the REST history fetch (#458) while cic omits the same
             kinds from the live-tail render. While they differ, page-up and
             the live tail disagree about which rows exist. Move BOTH or
             neither.
             """
    end
  end
end
