defmodule Grappa.IRC.MircFormat do
  @moduledoc """
  The de-formatted projection of an IRC body — every mIRC formatting
  control sequence removed, only the visible characters left.

  IRC has no markup spec; mIRC's de-facto control-char set is what every
  modern client and most IRCds emit. This module does NOT model that set
  the way a renderer must — it answers one question, "what did the reader
  actually see", and it exists because a predicate that reads the raw wire
  bytes answers a different question than the operator was asked.

  ## Why this exists (issue 1908)

  A watchlist keyword never matched a bot that colours its output.
  `Grappa.Mentions` ran its word-boundary regex against the RAW body while
  the operator configured the keyword by reading the RENDERED text.

  The failure is narrower than "control bytes in the body", and the narrow
  reading is the load-bearing one. The argument-free bytes below are not
  word characters, so `\\b` keeps its transition on both sides of a term and
  a bold-only sender always matched fine — measured in the field on a
  URL-title bot with 139 bold lines and zero misses. The COLOUR byte is
  different: it drags up to four decimal digits into the text, and digits
  ARE word characters, so `\\x03` `1` `5` before `QUACK` reads to the regex
  as `...15QUACK` and the term's left anchor has no transition left to sit
  on. **A stripper that removed the control bytes without their arguments
  would leave that bug fully intact.**

  ## The consumption rule, and why it is spelled this way

  Mirror of `cicchetto/src/lib/mircFormat.ts`'s `parseMircFormat`, which
  cic reaches through `mircPlainText/1`. The client cannot be reused here
  and the server has no renderer to derive a projection from, so a second
  implementation exists by necessity. What keeps the two from drifting is
  the shared consumption table in `test/grappa/irc/mirc_format_test.exs`
  plus the shared mention truth table in `test/grappa/mentions_test.exs` —
  the same lockstep discipline #1786's anchor rule runs under. A change to
  either side's rule MUST land in both.

    * the argument-free attribute bytes — bold `\\x02`, reset `\\x0F`,
      monospace `\\x11`, reverse `\\x16`, italic `\\x1D`, strikethrough
      `\\x1E`, underline `\\x1F` — are dropped on sight;
    * the colour byte `\\x03` takes UP TO TWO decimal digits, then
      optionally a comma AND one-to-two more. The comma is consumed only
      when digits follow it, so `\\x034,foo` leaves `,foo` as literal text
      — mIRC's own behaviour, and the client parser's documented lookahead;
    * the hex-colour byte `\\x04` is all-or-nothing on six hex digits; a
      partial run is not consumed and stays as text;
    * CTCP framing `\\x01` is NOT formatting and is preserved verbatim
      (CLAUDE.md's wire-format rule; the client parser says the same).

  The digit classes are written `[0-9]` rather than `\\d`, and the pattern
  carries no `unicode` option. That is deliberate: the client's `isDigit`
  is a bare `0x30..0x39` range test, so an Arabic-Indic digit is ordinary
  text there. A `\\d` under `unicode` would consume it and the two ports
  would silently disagree on a body neither author will ever type by hand.
  Byte semantics are also the honest ones here — CLAUDE.md's "IRC is
  bytes" — and they are safe on UTF-8 input because every sequence removed
  is ASCII, and a UTF-8 continuation byte is never below `0x80`.
  """

  # Written with the `x` (extended) flag so each alternative can carry the
  # rule it implements: this pattern IS the lockstep contract with the client
  # parser, and a reader has to be able to check it against that file.
  @formatting ~r/
      [\x02\x0F\x11\x16\x1D\x1E\x1F]                        # argument-free attributes
    | \x03 (?: [0-9]{1,2} (?: , [0-9]{1,2} )? )?            # palette colour, fg[,bg]
    | \x04 (?: [0-9A-Fa-f]{6} (?: , [0-9A-Fa-f]{6} )? )?    # hex colour, all-or-nothing
  /x

  @doc """
  Returns `body` with every mIRC formatting sequence removed — the text a
  reader saw on screen.

  Total on binaries and never raises: a body carrying no formatting comes
  back unchanged, and an unterminated or malformed sequence consumes only
  what the rule above says it consumes.
  """
  @spec plain_text(String.t()) :: String.t()
  def plain_text(body) when is_binary(body), do: Regex.replace(@formatting, body, "")
end
