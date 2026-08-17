defmodule Grappa.Protocol do
  @moduledoc """
  Single source of truth for the grappa REST + Phoenix-Channels wire
  PROTOCOL version — the integer a third-party client negotiates against
  (#447). Distinct from `Grappa.Version`, which is the human-facing
  *software* release string (`X.Y.Z-<sha>`, the CTCP VERSION reply); this
  is the *contract* number that governs whether two peers can talk at all.

  ## Two numbers

    * `version/0` — the protocol the server currently SPEAKS.
    * `min_version/0` — the OLDEST client protocol the server still
      accepts. The WS handshake rejects a client that declares below this
      with a `426 Upgrade Required` (`GrappaWeb.UserSocket`) rather than
      accepting the socket and feeding it frames it will mangle;
      `GET /api/config` publishes both so a client learns them BEFORE it
      connects.

  A client that declares no version at all is treated as current (the
  server sends nothing new to a silent client), so existing clients
  (cicchetto, shottino) keep working untouched — the negotiation is opt-in
  on the client side.

  ## Additive-only evolution (the contract, #447 item 4)

  New frame kinds, new event types, and new fields may appear at ANY time
  WITHOUT a version bump — a client MUST ignore verbs and fields it does
  not recognise (unknown-is-never-fatal, in BOTH directions: an unknown
  client verb earns a non-fatal error frame and the socket stays open).
  Existing fields are NEVER repurposed or removed. `version/0` therefore
  bumps ONLY for a change the additive rule cannot express — a field's
  meaning changes, or a frame is withdrawn — and such a change moves
  `min_version/0` too when old clients can no longer be served. The rule
  is written for client authors in `docs/CLIENT_PROTOCOL.md` and enforced
  in review (see the invariant in `CLAUDE.md`).

  ## Boundary

  Standalone top-level boundary, mirroring `Grappa.Version`: the web
  surface (`GrappaWeb.ConfigController`, `GrappaWeb.UserSocket`,
  `GrappaWeb.GrappaChannel`) reads these constants without crossing a
  deeper boundary edge. They are compile-time integers — no runtime state,
  no filesystem access.
  """

  use Boundary, top_level?: true, deps: [], exports: []

  # Protocol v1 — the initial published contract (#447). Bump ONLY per the
  # additive-only rule in the moduledoc: never for a field/verb/frame
  # ADDED (that is free), only for one whose meaning changed or that was
  # withdrawn. A bump that strands old clients must also raise
  # @min_protocol_version.
  @protocol_version 1
  @min_protocol_version 1

  @doc "The protocol version the server currently speaks."
  # `:: 1` (not `pos_integer()`) so the spec matches the success typing of
  # the literal constant under Dialyzer `:underspecs` — the codebase idiom
  # for a constant-returning function (`Grappa.Notify.max_entries/0 :: 64`,
  # `Grappa.IRC.Identifier.max_nick_length/0 :: 30`). A bump edits the spec
  # alongside `@protocol_version`, which is a deliberate, reviewed event
  # per the additive-only rule — the spec doubles as the bump tripwire.
  @spec version() :: 1
  def version, do: @protocol_version

  @doc """
  The oldest client protocol version the server still accepts. A client
  declaring below this is refused at the WS handshake with 426.
  """
  @spec min_version() :: 1
  def min_version, do: @min_protocol_version
end
