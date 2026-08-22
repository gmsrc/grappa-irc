defmodule Grappa.IRC.ConnectFailureDescriptionTest do
  @moduledoc """
  #1675 — `Grappa.IRC.Client.describe_connect_failure/1`.

  The reason string this produces is what the operator reads in cicchetto
  (`connection_state_reason`) and in the `$server` window, so it has to
  carry the ACTUAL cause, not a category label. Every shape pinned here
  is one the connect path really produces — the POSIX atoms from
  `:gen_tcp.connect/4`, the `:ssl` alert tuple, and our own
  `{:source_family_mismatch, …}` from `source_bind/2`.

  The unknown arm is deliberately `inspect/1` rather than a friendly
  fallback: an unmapped shape must stay diagnosable, and a "connection
  failed" that hides the tuple is exactly the category label this issue
  is about.
  """
  use ExUnit.Case, async: true

  alias Grappa.IRC.Client

  describe "POSIX connect errors" do
    test "names the cause in words, one line, no atom syntax" do
      assert Client.describe_connect_failure(:econnrefused) =~ "refused"
      assert Client.describe_connect_failure(:timeout) =~ "timeout"
      assert Client.describe_connect_failure(:etimedout) =~ "timeout"
      assert Client.describe_connect_failure(:nxdomain) =~ "not found"
      assert Client.describe_connect_failure(:ehostunreach) =~ "unreachable"
      assert Client.describe_connect_failure(:enetunreach) =~ "unreachable"
    end
  end

  describe "the three shapes prod produced on 2026-08-22" do
    test "a TLS alert keeps the alert AND the description OTP gave us" do
      described =
        Client.describe_connect_failure(
          {:tls_alert,
           {:handshake_failure,
            ~c"TLS client: In state wait_cert_cr at ssl_handshake.erl:2126 generated CLIENT ALERT: Fatal - Handshake Failure - {bad_cert,{hostname_check_failed,{requested,\"irc.ircnet.com\"},{received,[{dNSName,\"ircnet.tngnet.nl\"}]}}}"}}
        )

      assert described =~ "tls"
      assert described =~ "handshake_failure"
      # The hostnames are the whole diagnosis — vjt could not tell the
      # misconfigured endpoint from a flaky network without them.
      assert described =~ "irc.ircnet.com"
      assert described =~ "ircnet.tngnet.nl"
    end

    test "a source-family mismatch says which side is which" do
      described =
        Client.describe_connect_failure({:source_family_mismatch, "2a01:4f8::1", "irc.undernet.org", :inet6})

      assert described =~ "2a01:4f8::1"
      assert described =~ "irc.undernet.org"
      assert described =~ "IPv6"
      # The host is the A-only side — say so, don't leave the reader to
      # infer it from the family of the source.
      assert described =~ "AAAA"
    end

    test "an IPv4 source against a v6-only host reads the mirror image" do
      described =
        Client.describe_connect_failure({:source_family_mismatch, "10.0.0.1", "irc.example", :inet})

      assert described =~ "IPv4"
      assert described =~ "A record"
    end
  end

  describe "the contract every arm owes the DB column" do
    test "never returns CR, LF or NUL — the changeset rejects them" do
      multiline =
        Client.describe_connect_failure({:tls_alert, {:handshake_failure, ~c"line one\nline two\r\n"}})

      refute multiline =~ "\n"
      refute multiline =~ "\r"
      refute multiline =~ <<0>>
    end

    test "is bounded — an OTP alert description must not become the whole column" do
      long =
        Client.describe_connect_failure({:tls_alert, {:handshake_failure, List.duplicate(?x, 4_000)}})

      # Bounded in GRAPHEMES, not bytes: a byte-sliced string can end
      # mid-codepoint, and the column stores Elixir-canonical UTF-8.
      assert String.length(long) <= 500
      assert String.ends_with?(long, "…")
    end

    test "an unmapped shape stays diagnosable rather than becoming a category" do
      described = Client.describe_connect_failure({:something_new, %{code: 42}})

      assert described =~ "something_new"
      assert described =~ "42"
    end
  end
end
