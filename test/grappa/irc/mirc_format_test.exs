defmodule Grappa.IRC.MircFormatTest do
  @moduledoc """
  Tests for `Grappa.IRC.MircFormat.plain_text/1` — the server-side
  de-formatted projection of an IRC body (issue 1908).

  THE TABLE BELOW IS THE CONSUMPTION RULE, and it is SHARED with
  `cicchetto/src/lib/mircFormat.ts`'s `parseMircFormat`. The server cannot
  reuse the client parser, so a second implementation exists by necessity;
  what keeps the two from drifting is this table plus the mention truth
  table in `test/grappa/mentions_test.exs`. A case changed here without its
  client twin is how the visual highlight and the OS push start disagreeing
  about which messages notify.

  The rule the client parser implements, verb for verb:

    * the argument-free attribute bytes are dropped on sight;
    * the colour byte takes UP TO TWO decimal digits, then optionally a
      comma AND one-to-two more — the comma is consumed only when digits
      follow it, so a stray comma stays as literal text;
    * the hex-colour byte is all-or-nothing on six hex digits; a partial
      run is not consumed and stays as text;
    * CTCP framing is NOT formatting and is preserved verbatim.
  """
  use ExUnit.Case, async: true

  alias Grappa.IRC.MircFormat

  # Spelled as byte literals rather than "\\x03" escapes: Elixir's `\\xHH`
  # takes up to two hex digits, so the escaped form reads ambiguously in
  # exactly the place where digits-glued-to-the-byte IS the defect under test.
  # Same spelling as `Grappa.IRC.CTCP`'s `<<0x01, ...>>`.
  @color <<0x03>>
  @hex_color <<0x04>>
  @ctcp <<0x01>>

  describe "plain_text/1 — text that must survive untouched" do
    test "plain text is returned verbatim" do
      assert MircFormat.plain_text("QUACK!") == "QUACK!"
    end

    test "an empty body stays empty" do
      assert MircFormat.plain_text("") == ""
    end

    test "digits that are real text are NOT removed" do
      # The negative control for the whole module: the projection consumes
      # digits only as colour ARGUMENTS. If this ever goes red the stripper
      # has started eating content.
      assert MircFormat.plain_text("15 ducks seen") == "15 ducks seen"
      assert MircFormat.plain_text("15QUACK!") == "15QUACK!"
    end

    test "CTCP framing is preserved — it is not formatting" do
      # CLAUDE.md's wire-format rule: `\\x01` round-trips verbatim, and the
      # client parser deliberately treats it as plain text for the same
      # reason. An ACTION body must come out of here still framed.
      body = @ctcp <> "ACTION waves" <> @ctcp
      assert MircFormat.plain_text(body) == body
    end
  end

  describe "plain_text/1 — the argument-free attribute bytes" do
    test "every toggle and the reset are dropped on sight" do
      for {name, byte} <- [
            bold: <<0x02>>,
            reset: <<0x0F>>,
            monospace: <<0x11>>,
            reverse: <<0x16>>,
            italic: <<0x1D>>,
            strikethrough: <<0x1E>>,
            underline: <<0x1F>>
          ] do
        assert MircFormat.plain_text(byte <> "QUACK!" <> byte) == "QUACK!",
               "#{name} byte survived the projection"
      end
    end
  end

  describe "plain_text/1 — the colour byte takes its arguments with it" do
    test "one and two digit foreground codes" do
      assert MircFormat.plain_text(@color <> "4QUACK!") == "QUACK!"
      assert MircFormat.plain_text(@color <> "15QUACK!") == "QUACK!"
      assert MircFormat.plain_text(@color <> "04QUACK!") == "QUACK!"
      assert MircFormat.plain_text(@color <> "99QUACK!") == "QUACK!"
      assert MircFormat.plain_text(@color <> "00QUACK!") == "QUACK!"
    end

    test "foreground and background" do
      assert MircFormat.plain_text(@color <> "04,01QUACK!") == "QUACK!"
      assert MircFormat.plain_text(@color <> "4,1QUACK!") == "QUACK!"
    end

    test "a bare colour byte consumes nothing but itself" do
      assert MircFormat.plain_text(@color <> "QUACK!") == "QUACK!"
    end

    test "only TWO digits are arguments — a third is text" do
      assert MircFormat.plain_text(@color <> "045QUACK!") == "5QUACK!"
    end

    test "a stray comma with no digits after it stays literal" do
      # mIRC's own rule, and the client parser's documented lookahead: the
      # comma is only part of the code when a background code follows.
      assert MircFormat.plain_text(@color <> "4,foo") == ",foo"
    end

    test "a comma directly after a bare colour byte stays literal" do
      assert MircFormat.plain_text(@color <> ",01QUACK!") == ",01QUACK!"
    end

    test "non-ASCII digits are NOT colour arguments" do
      # The client's `isDigit` is a bare 0x30-0x39 range test, so an
      # Arabic-Indic digit is ordinary text there. A server regex compiled
      # with the `unicode` option would consume it and the two ports would
      # silently disagree on a body neither author will ever type by hand.
      arabic_one = "١"
      assert MircFormat.plain_text(@color <> arabic_one <> "QUACK!") == arabic_one <> "QUACK!"
    end
  end

  describe "plain_text/1 — the hex colour byte is all-or-nothing" do
    test "a full six-hex foreground is consumed" do
      assert MircFormat.plain_text(@hex_color <> "FF0000QUACK!") == "QUACK!"
    end

    test "six-hex foreground and background" do
      assert MircFormat.plain_text(@hex_color <> "FF0000,00FF00QUACK!") == "QUACK!"
    end

    test "a PARTIAL hex run is not consumed and stays as text" do
      assert MircFormat.plain_text(@hex_color <> "FF00QUACK!") == "FF00QUACK!"
    end

    test "a partial BACKGROUND leaves the comma and the digits as text" do
      assert MircFormat.plain_text(@hex_color <> "FF0000,00FFQUACK!") == ",00FFQUACK!"
    end

    test "a bare hex-colour byte consumes nothing but itself" do
      assert MircFormat.plain_text(@hex_color <> "QUACK!") == "QUACK!"
    end
  end

  describe "plain_text/1 — the field case" do
    test "the duck bot's real line reduces to its visible text" do
      body =
        @color <>
          "15" <>
          <<0x0F>> <>
          " " <>
          <<0x02>> <>
          "\\_O<" <>
          <<0x0F>> <>
          "  " <>
          @color <> "15QUACK!" <> <<0x0F>>

      assert MircFormat.plain_text(body) == " \\_O<  QUACK!"
    end
  end
end
