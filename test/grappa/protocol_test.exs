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
end
