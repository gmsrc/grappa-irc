defmodule GrappaWeb.ConfigController do
  @moduledoc """
  Unauthenticated protocol-discovery endpoint (#447).

  `GET /api/config` is what a third-party client hits FIRST — before it
  authenticates or opens a WebSocket — to learn what it is talking to and
  whether it can speak the protocol:

    * `protocol_version` — the wire protocol the server currently speaks
      (`Grappa.Protocol.version/0`).
    * `min_protocol_version` — the floor below which the server refuses a
      WS handshake with 426 (`Grappa.Protocol.min_version/0`). A client
      compares its own protocol against this BEFORE connecting.
    * `server` — the server identity/edition (`"grappa"`).
    * `version` — the human-facing software release string
      (`Grappa.Version.current/0`, the CTCP VERSION value). Diagnostic,
      NOT the negotiation number — a client keys compatibility off
      `protocol_version`, never this.

  No auth, no secrets, snake_case like the whole wire contract (the
  divergence from the issue's camelCase spelling is deliberate — see
  DESIGN_NOTES 2026-07-27; the authoritative client-author contract is
  `docs/CLIENT_PROTOCOL.md`).

  Cacheable: a client hits this on every cold start and the values only
  move on deploy, so a short `Cache-Control` is emitted. The staleness
  window is harmless — the WS handshake is the real enforcement point for
  `min_protocol_version` (a too-old client is refused there, 426),
  `/api/config` is only the advisory pre-check.
  """
  use GrappaWeb, :controller

  @doc "GET /api/config — unauthenticated protocol + identity discovery."
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, _) do
    conn
    |> put_resp_header("cache-control", "public, max-age=60")
    |> json(%{
      server: "grappa",
      version: Grappa.Version.current(),
      protocol_version: Grappa.Protocol.version(),
      min_protocol_version: Grappa.Protocol.min_version()
    })
  end
end
