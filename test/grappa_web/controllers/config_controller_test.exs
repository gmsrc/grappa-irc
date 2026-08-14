defmodule GrappaWeb.ConfigControllerTest do
  @moduledoc """
  #447 — unauthenticated protocol-discovery endpoint. `GET /api/config` is
  what a third-party client hits FIRST, before it authenticates or opens a
  WebSocket: it learns the wire protocol the server speaks
  (`protocol_version`), the floor below which the server refuses a WS
  handshake (`min_protocol_version`), and the server identity/edition. No
  auth, no secrets.

  Wire keys are snake_case — the whole grappa contract is snake_case
  without exception, so the issue's camelCase spelling was NOT followed
  (deliberate divergence, DESIGN_NOTES 2026-07-27). The anti-camelCase
  guard below pins that decision so a future edit can't quietly reintroduce
  a `protocolVersion` island — the FIRST field a third-party author meets.
  """
  use GrappaWeb.ConnCase, async: true

  alias Grappa.{Protocol, Push, Version}

  describe "GET /api/config" do
    test "publishes protocol_version, min_protocol_version + server identity", %{conn: conn} do
      body =
        conn
        |> get("/api/config")
        |> json_response(200)

      # Values come from the SSOTs, never hardcoded literals — a bump to
      # the constant flows through without touching this test.
      assert body["protocol_version"] == Protocol.version()
      assert body["min_protocol_version"] == Protocol.min_version()
      assert body["server"] == "grappa"
      assert body["version"] == Version.current()
    end

    test "publishes the push content coding as an explicit capability (#1290)", %{conn: conn} do
      body =
        conn
        |> get("/api/config")
        |> json_response(200)

      # The reason this field exists: the switch off the pre-RFC `aesgcm`
      # drafts is invisible to the WS protocol, so it does not move
      # `protocol_version`, and this endpoint's own docstring forbids
      # gating on `version`. Without the field a client holding an
      # undecryptable payload cannot tell a broken crypto path from an
      # old server.
      assert body["push_content_encoding"] == Push.content_encoding()
      assert body["push_content_encoding"] == "aes128gcm"
    end

    test "requires no authentication — it is pre-auth discovery", %{conn: conn} do
      # No Authorization header at all: the route is outside :authn, so a
      # client with no session still gets a 200 (not the 401 the authed
      # surface returns).
      assert conn
             |> get("/api/config")
             |> json_response(200)
    end

    test "keys are snake_case — no camelCase island in the wire contract", %{conn: conn} do
      body =
        conn
        |> get("/api/config")
        |> json_response(200)

      refute Map.has_key?(body, "protocolVersion")
      refute Map.has_key?(body, "minProtocolVersion")
    end
  end
end
