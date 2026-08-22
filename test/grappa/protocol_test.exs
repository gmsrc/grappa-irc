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

  The last two describes are the odd ones out and deliberately so: they read
  cic's source. #1379 made cicchetto DECLARE its protocol version, which turns
  the 426 refusal from unreachable-against-cic into live-against-cic — so
  raising `min_version/0` now bricks every un-updated bundle at the handshake.
  That consequence has to be visible at the commit that raises the floor, and
  only a test spanning both sides can show it. #1393d added the mirror-image
  constant on cic's side and #1654 pins it here for the same reason.
  `cicchetto/src` is mounted into the Elixir test container
  (`scripts/_lib.sh`), so this reads the change under test, not main's copy —
  the same reasoning that put the version carrier's cic half on the cic side
  (`version_single_source_test.exs`).
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

  # 🔴 THIS IS NOT THE GATE #1654 ASKS FOR. It is the half of it that can be
  # written against facts the repo holds today, shipped as such.
  #
  # #1393d gave cic a floor for the SERVER it is talking to
  # (`MIN_SERVER_PROTOCOL_VERSION`, `cicchetto/src/lib/serverProtocol.ts`):
  # below it, a "server outdated" banner instead of envelopes silently
  # dropped by a narrower. The obligation that comes with it is that
  # narrowing any client guard to REQUIRE a field introduced by protocol
  # version N obliges raising the floor to N in the same change.
  #
  # What these two tests catch: the floor pointing ABOVE every server that
  # can exist — say `MIN_SERVER_PROTOCOL_VERSION = 5` while `version/0` is 2,
  # which banners "server outdated" at every operator on a fully current
  # deploy — and the constant vanishing altogether.
  #
  # 🔴 What they do NOT catch, which is precisely the defect #1654 is about:
  # forgetting to RAISE the floor. Tighten a narrower onto a v5 field and
  # leave the floor at 2, and `2 <= 5` still holds — this stays GREEN through
  # exactly the edit that reintroduces the silent mode. Nor does the wire pin
  # span it: `mix grappa.wire_pin`'s digest is taken over the SERVER's two
  # generated artefacts, so a `wireNarrow.ts` edit moves nothing it covers.
  #
  # Catching the real defect needs a fact this repo does not hold — WHICH
  # protocol version introduced each field. `priv/wire/shape.pin` is a digest
  # of the CURRENT shape beside the CURRENT number, not a history. Building
  # that ledger is the open half of #1654 and a design decision, not a test.
  describe "the SERVER floor cicchetto declares (#1654) — half-measure, not the gate" do
    @cic_server_protocol "cicchetto/src/lib/serverProtocol.ts"

    test "cicchetto declares a MIN_SERVER_PROTOCOL_VERSION at all" do
      # The carrier. Deleting or renaming the constant is how the floor
      # silently reverts to the pre-#1393d posture where cic accepts any
      # server and shows no banner for one too old to serve it.
      assert is_integer(cic_min_server_protocol_version())
    end

    test "cic's server floor is at or below the protocol the server speaks" do
      # Fails on a floor raised past `version/0` — a bundle that banners
      # "server outdated" against the newest server that exists, which is
      # unshippable and otherwise reaches an operator before it reaches a
      # test. It does NOT fail on a floor left too low; see above.
      assert cic_min_server_protocol_version() <= Protocol.version()
    end
  end

  # An integer literal cicchetto declares. Source text, not a build artifact:
  # the point is to catch the edit, and nothing in the Elixir test container
  # can execute the bundle.
  #
  # A missing constant FLUNKS rather than returning nil, because Elixir's term
  # order puts every atom above every integer: `nil >= Protocol.min_version()`
  # and `nil <= Protocol.version()` are `true` and `false` respectively — the
  # first passes vacuously on exactly the edit it exists to catch, and neither
  # names what actually went wrong. Both readers below compare, so both need
  # the flunk; that shared need is why this is one function and not two.
  defp cic_integer_constant(path, name) do
    case Regex.run(~r/^export const #{Regex.escape(name)} = (\d+);$/m, File.read!(path)) do
      [_, digits] -> String.to_integer(digits)
      nil -> flunk("no `export const #{name} = <int>;` in #{path}")
    end
  end

  defp cic_protocol_version, do: cic_integer_constant(@cic_socket, "CLIENT_PROTOCOL_VERSION")

  defp cic_min_server_protocol_version,
    do: cic_integer_constant(@cic_server_protocol, "MIN_SERVER_PROTOCOL_VERSION")
end
