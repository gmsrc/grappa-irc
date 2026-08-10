defmodule Grappa.RelayFrameHelpers do
  @moduledoc """
  The worst-case RELAYED wire frame (#246), built from the protocol
  ceilings — a deliberate INDEPENDENT restatement of what the server puts
  on the wire around a body.

  Nothing here may call `Grappa.IRC.LineSplit`. That is the whole point: a
  budget assertion whose expected value comes from the same arithmetic it
  is checking moves WITH a defect instead of catching it (#1108). Assert
  against the bytes this module builds and the oracle is the wire, not the
  splitter's own opinion of the wire.

  The ceilings are the protocol maxima grappa validates its own identity
  against — `Grappa.IRC.Identifier` `@nick_regex` (≤30, Azzurra
  NICKLEN=30) and `@ident_regex` (≤10, common USERLEN) — plus the common
  ircd HOSTLEN 63 (covers cloaks and bracketed IPv6 literals). They are
  spelled out rather than imported so that moving a ceiling in production
  is a visible, deliberate edit here too.
  """

  @wc_nick String.duplicate("n", 30)
  @wc_ident String.duplicate("u", 10)
  @wc_host String.duplicate("h", 63)
  @wc_source_prefix ":" <> @wc_nick <> "!" <> @wc_ident <> "@" <> @wc_host <> " "

  @doc "The concrete worst-case relayed wire frame around `fragment`."
  @spec worst_case_relayed_frame(String.t(), String.t()) :: String.t()
  def worst_case_relayed_frame(target, fragment)
      when is_binary(target) and is_binary(fragment) do
    @wc_source_prefix <> "PRIVMSG #{target} :" <> fragment <> "\r\n"
  end

  @doc """
  Asserts that `budget` is EXACTLY the largest body that survives a relay
  on a `linelen`-byte wire for `target`: a body of that many bytes fills
  the worst-case frame to the brim.

  EQUALITY, not `<=`, and that is what makes it two-sided in one line: a
  budget one byte too generous overruns the frame, one byte too mean
  leaves a byte unused. `<=` would accept every under-count, which is the
  half of the space a published budget is most likely to drift into.
  """
  @spec assert_budget_fills_the_frame(integer(), String.t(), pos_integer()) :: true
  def assert_budget_fills_the_frame(budget, target, linelen)
      when is_integer(budget) and is_binary(target) and is_integer(linelen) do
    framed = byte_size(worst_case_relayed_frame(target, String.duplicate("a", budget)))

    ExUnit.Assertions.assert(
      framed == linelen,
      "a body of the published budget (#{budget}B) must fill the #{linelen}B relayed " <>
        "frame for #{target} exactly — got #{framed}B"
    )
  end
end
