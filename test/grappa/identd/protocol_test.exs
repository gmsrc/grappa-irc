defmodule Grappa.Identd.ProtocolTest do
  @moduledoc """
  Pure RFC 1413 request/response unit tests (issue 227).

  The protocol module is the only place that turns bytes into ports and
  ports into a reply line, so every framing rule the listener depends on
  is pinned here rather than through a socket.

  CR/LF are built numerically (`@crlf`) and never written as source
  escapes — see the CTCP module for the same house spelling.
  """
  use ExUnit.Case, async: true

  alias Grappa.Identd.Protocol

  @crlf <<13, 10>>

  describe "parse_query/1" do
    test "parses the canonical RFC 1413 port pair" do
      assert Protocol.parse_query("6191 , 23" <> @crlf) == {:ok, {6191, 23}}
    end

    test "parses a pair with no surrounding whitespace" do
      assert Protocol.parse_query("6191,23") == {:ok, {6191, 23}}
    end

    test "tolerates a bare LF terminator" do
      assert Protocol.parse_query("6191 , 23" <> <<10>>) == {:ok, {6191, 23}}
    end

    test "rejects a port above 65535" do
      assert Protocol.parse_query("70000 , 23" <> @crlf) == :error
    end

    test "rejects port zero — no connection can carry it" do
      assert Protocol.parse_query("0 , 23" <> @crlf) == :error
    end

    test "rejects a negative port" do
      assert Protocol.parse_query("-1 , 23" <> @crlf) == :error
    end

    test "rejects trailing junk after a port" do
      assert Protocol.parse_query("6191 , 23x" <> @crlf) == :error
    end

    test "rejects a line with no comma" do
      assert Protocol.parse_query("6191 23" <> @crlf) == :error
    end

    test "rejects a line carrying a non-ASCII byte" do
      assert Protocol.parse_query(<<"6191 , 23", 0xC3, 0xA9>> <> @crlf) == :error
    end

    test "rejects an empty line" do
      assert Protocol.parse_query(@crlf) == :error
    end
  end

  describe "userid_reply/3" do
    test "renders the RFC 1413 USERID line, CRLF-terminated" do
      assert Protocol.userid_reply(6191, 23, "grappa") ==
               "6191 , 23 : USERID : UNIX : grappa" <> @crlf
    end

    test "echoes the ports as integers, never as caller-supplied bytes" do
      # The ports come back re-rendered from the parsed integers, which is
      # what makes an echo safe: nothing from the query reaches the wire.
      {:ok, {a, b}} = Protocol.parse_query("00042 , 6667" <> @crlf)
      assert Protocol.userid_reply(a, b, "grappa") =~ "42 , 6667 : USERID"
    end
  end

  describe "error_reply/2" do
    test "renders the uniform NO-USER line, CRLF-terminated" do
      assert Protocol.error_reply(6191, 23) == "6191 , 23 : ERROR : NO-USER" <> @crlf
    end

    test "renders the portless form used for an unparseable query" do
      assert Protocol.error_reply(0, 0) == "0 , 0 : ERROR : NO-USER" <> @crlf
    end
  end

  describe "safe_userid?/1" do
    test "accepts the ident shapes the USER line already carries" do
      assert Protocol.safe_userid?("grappa")
      assert Protocol.safe_userid?("vjt_1")
      # A nick-derived ident (Identity.effective_ident/2 falls back to the
      # nick) may carry RFC-2812 nick punctuation that valid_ident?/1 would
      # refuse. The identd must still answer with it: it is the exact value
      # already sent as `USER <ident>`.
      assert Protocol.safe_userid?("foo[1]")
      assert Protocol.safe_userid?("a|b")
    end

    test "rejects the bytes that would break the single-line framing" do
      refute Protocol.safe_userid?("bad" <> <<13>>)
      refute Protocol.safe_userid?("bad" <> <<10>>)
      refute Protocol.safe_userid?("bad" <> <<0>>)
    end

    test "rejects a colon — it is the reply's field delimiter" do
      refute Protocol.safe_userid?("bad:user")
    end

    test "rejects an empty user-id" do
      refute Protocol.safe_userid?("")
    end

    test "rejects a user-id past the RFC 1413 512-octet ceiling" do
      refute Protocol.safe_userid?(String.duplicate("a", 513))
      assert Protocol.safe_userid?(String.duplicate("a", 512))
    end

    test "rejects a non-binary" do
      refute Protocol.safe_userid?(nil)
      refute Protocol.safe_userid?(:grappa)
    end
  end
end
