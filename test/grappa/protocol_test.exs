defmodule Grappa.ProtocolTest do
  @moduledoc """
  #447 — the REST + Phoenix-Channels wire PROTOCOL version a third-party
  client negotiates against, distinct from `Grappa.Version` (the software
  release string). Pure-constant contract tests: the two numbers are sane
  and the additive-only floor invariant (`min_version <= version`) holds —
  the server can always speak its own advertised minimum.

  The end-to-end proofs that the numbers reach the wire live where the wire
  is exercised: `GET /api/config` (`config_controller_test.exs`) and the WS
  handshake 426 (`user_socket_test.exs`).

  The last describe is the odd one out and deliberately so: it reads cic's
  source. #1379 made cicchetto DECLARE its protocol version, which turns the
  426 refusal from unreachable-against-cic into live-against-cic — so raising
  `min_version/0` now bricks every un-updated bundle at the handshake. That
  consequence has to be visible at the commit that raises the floor, and only
  a test spanning both sides can show it. `cicchetto/src` is mounted into the
  Elixir test container (`scripts/_lib.sh`), so this reads the change under
  test, not main's copy — the same reasoning that put the version carrier's
  cic half on the cic side (`version_single_source_test.exs`).
  """
  use ExUnit.Case, async: true

  alias Grappa.Protocol

  describe "version/0 + min_version/0" do
    test "both are positive integers" do
      assert is_integer(Protocol.version()) and Protocol.version() > 0
      assert is_integer(Protocol.min_version()) and Protocol.min_version() > 0
    end

    test "min_version never exceeds version — the server can always speak its own floor" do
      assert Protocol.min_version() <= Protocol.version()
    end
  end

  describe "the floor vs what cicchetto declares (#1379)" do
    @cic_socket "cicchetto/src/lib/socket.ts"

    test "cicchetto declares a CLIENT_PROTOCOL_VERSION at all" do
      # The carrier itself. Deleting the constant (or renaming it) is how the
      # declaration silently reverts to the pre-#1379 posture where cic sends
      # no `client_proto` and the server treats any bundle as current.
      assert is_integer(cic_protocol_version())
    end

    test "cicchetto's declared version is at or above the floor — raising min_version bricks stale bundles" do
      # Fails on the commit that raises `min_version/0` without shipping a cic
      # bundle that declares the new number. That is not a false alarm: with
      # #1379 in, such a deploy 426s the reference client at the handshake,
      # and a browser cannot read the 426 body, so the user sees an endless
      # silent reconnect loop rather than an error. The two numbers move
      # together or the floor does not move.
      assert cic_protocol_version() >= Protocol.min_version()
    end
  end

  # The integer literal cicchetto declares. Source text, not a build artifact:
  # the point is to catch the edit, and nothing in the Elixir test container
  # can execute the bundle.
  #
  # A missing constant FLUNKS rather than returning nil, because Elixir's term
  # order puts every atom above every integer: `nil >= Protocol.min_version()`
  # is `true`, so the floor comparison below would pass vacuously on exactly
  # the edit it exists to catch.
  defp cic_protocol_version do
    case Regex.run(~r/^export const CLIENT_PROTOCOL_VERSION = (\d+);$/m, File.read!(@cic_socket)) do
      [_, digits] -> String.to_integer(digits)
      nil -> flunk("no `export const CLIENT_PROTOCOL_VERSION = <int>;` in #{@cic_socket}")
    end
  end
end
