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

  ## Evolution: additive on the WIRE, and `version/0` moves anyway (#1393d)

  New frame kinds, new event types, and new fields may still appear at ANY
  time — a client MUST ignore verbs and fields it does not recognise
  (unknown-is-never-fatal, in BOTH directions: an unknown client verb earns
  a non-fatal error frame and the socket stays open), and existing fields
  are NEVER repurposed or removed. That half of #447 is unchanged and is
  what keeps an OLD client working against a NEW server.

  What changed on 2026-08-21 is the other half. This moduledoc used to say
  such a change lands *"WITHOUT a version bump"*, and it was true right up
  until a client started REQUIRING one of those additive fields. #1393d is
  that client: cic now rejects an `isupport_changed` whose
  `list_modes_queryable` is missing rather than inventing one. Nothing
  about that is expressible additively — it is a NEW client that can no
  longer talk to an OLD server — and it is exactly the case the bump was
  reserved for.

  **So `version/0` now bumps on EVERY wire-shape change, additive
  included** (vjt's ruling, 2026-08-21). The reason is that the number is
  only useful if it is TOTAL: a client comparing against a floor is
  entitled to read "server >= N" as "server has everything N had", and one
  un-bumped field addition makes that reading false forever after. A floor
  that lies is worse than no floor, because the client believes it checked.
  Measured: `@protocol_version` sat at `1` from #447 (2026-07-27) through
  five additive fields — `recoverable`, `inviter`, `list_modes_queryable`,
  `chantypes`, `prefix_order` — every one of which cic later came to
  require.

  `min_version/0` is a DIFFERENT axis and does NOT follow: it moves only
  when old clients can no longer be SERVED. An additive field strands
  nobody, so a bump under the new rule leaves the floor where it is —
  which is why `version/0` is 2 here and `min_version/0` is still 1.

  The rule is written for client authors in `docs/CLIENT_PROTOCOL.md` and
  restated as an invariant in `CLAUDE.md`.

  ## Boundary

  Standalone top-level boundary, mirroring `Grappa.Version`: the web
  surface (`GrappaWeb.ConfigController`, `GrappaWeb.UserSocket`,
  `GrappaWeb.GrappaChannel`) reads these constants without crossing a
  deeper boundary edge. They are compile-time integers — no runtime state,
  no filesystem access.
  """

  use Boundary, top_level?: true, deps: [], exports: []

  # Protocol v2 (#1393d) — v1 was the initial published contract (#447).
  # Bump this on EVERY wire-shape change, additive included, per the
  # moduledoc: the number is only worth comparing against if it is total.
  #
  # @min_protocol_version is NOT the same axis and stays at 1: it rises only
  # when old clients can no longer be SERVED, and every client that spoke v1
  # is still served — v1 clients tolerate what v2 clients require.
  @protocol_version 2
  @min_protocol_version 1

  @doc "The protocol version the server currently speaks."
  # `:: 2` (not `pos_integer()`) so the spec matches the success typing of
  # the literal constant under Dialyzer `:underspecs` — the codebase idiom
  # for a constant-returning function (`Grappa.Notify.max_entries/0 :: 64`,
  # `Grappa.IRC.Identifier.max_nick_length/0 :: 30`). A bump edits the spec
  # alongside `@protocol_version`; the spec doubles as the bump tripwire,
  # and now that the bump is routine the tripwire is what keeps it from
  # being done half-way.
  @spec version() :: 2
  def version, do: @protocol_version

  @doc """
  The oldest client protocol version the server still accepts. A client
  declaring below this is refused at the WS handshake with 426.
  """
  @spec min_version() :: 1
  def min_version, do: @min_protocol_version
end
