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
  which is why `version/0` has moved repeatedly while `min_version/0` has
  never left 1. (Deliberately not restating either number in prose: this
  paragraph outlived two bumps naming the old one.)

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

  # Protocol v5 (#1675) — v1 was the initial published contract (#447), v2
  # the ruling that made the bump unconditional (#1393d), v3 added
  # `tls_verify` to `Grappa.Networks.Servers.AdminWire.t` (#1677), v4 added
  # the `GET /boot` envelope (`GrappaWeb.BootJSON.index/1`): networks, every
  # network's channel tree, and each channel's head page in one round trip
  # (#1679). v5 adds the `failing` value to
  # `NETWORKS_CREDENTIAL_CONNECTION_STATE` and the `link_failure` key to the
  # scrollback meta allowlist.
  #
  # A fourth value in a literal union is the additive case the #1393d
  # ruling is about, and it is the direction that bites: a client that
  # starts REQUIRING `failing` (to grey a hammering network, say) cannot
  # be served by a server that never emits it, and nothing on the server
  # side would express that break without this number moving. Which
  # version it lands in is not a judgement call either — `mix
  # grappa.wire_pin --update` refuses to rewrite the digest while the
  # number stands still, so a moved shape either bumps or stays red.
  #
  # v5 and not v4 because this branch was written against v3 and #1679
  # landed v4 first: the rebase put TWO wire changes in one digest, and the
  # pin recomputed against the union rather than against either half.
  #
  # Purely ADDITIVE — no existing endpoint changed shape, and a v3 client
  # that never calls `/boot` is served exactly as before. It bumps anyway,
  # which is the rule working rather than a cost to route around: the moment
  # a client stops fanning out and starts REQUIRING `/boot`, it can no longer
  # talk to a server predating it, and that break runs new-client → old-server
  # — the direction the number exists for.
  #
  # Not adjudicated by hand: `mix grappa.wire_pin --check` went red on the
  # digest and named `3 -> 4` (see `Mix.Tasks.Grappa.WirePin`). Worth
  # recording that it was SILENT until `GrappaWeb.BootJSON` was added to the
  # codegen's `@extra_modules` — the routed, rendered, tested endpoint agreed
  # with protocol 3 at rc=0 beforehand, because the digested set is a glob
  # over `lib/grappa/**` plus a hand-kept list of web-layer envelopes.
  #
  # v6 (#1766) adds `show_bottom_bar` to the `display_prefs` object on
  # `GET/PUT /me/settings/display-prefs` — the mobile window bar's per-user
  # off switch. Additive, and it bumps for the #1393d reason: a client that
  # comes to REQUIRE the key cannot be served by a server predating it, and
  # nothing server-side would express that break without this number moving.
  #
  # ⚠️ `mix grappa.wire_pin --check` did NOT force this one and could not, so
  # do not read a green pin as "no bump needed". The digest spans the codegen
  # artefacts, whose sources are `lib/grappa/**/*wire.ex` plus a hand-kept
  # `@extra_modules` list of web-layer envelopes, and
  # `GrappaWeb.UserSettingsJSON` is not on it. That is the SAME silence #1679
  # hit with `BootJSON` — recorded there as a gap in the detector, not as a
  # boundary of the rule, and still open for every hand-written `*_json.ex`.
  # Widening the digest is a COVERAGE change, which the pin deliberately
  # cannot tell from a shape change (its moduledoc: delete and re-create, no
  # `--force`), so it is not smuggled in alongside a product change.
  #
  # v7 (#1769) adds an INBOUND shape rather than an outbound one: the
  # per-channel topic now reads a join param, `%{"presence" => false}`, and a
  # socket that sends it stops being pushed peer join/part/quit. Additive in
  # both directions — only the literal `false` suppresses, so a client that
  # joins the way it joins today receives what it receives today — and it
  # bumps for the #1393d reason all the same: the break it expresses runs
  # new-client → old-server. A cic that has come to rely on the pause will
  # ask an old server for it, be silently served the full flood, and have no
  # way to know except this number.
  #
  # ⚠️ `mix grappa.wire_pin --check` was SILENT here too — measured, with the
  # channel change already applied it answered `wire shape and protocol 6
  # agree.` It could not have done otherwise: the digest spans the codegen
  # artefacts, and a join param read in `GrappaWeb.GrappaChannel.join/3` is
  # in no `*wire.ex` and on no `@extra_modules` list. Third recorded instance
  # of the same detector gap (#1679 `BootJSON`, #1766 `UserSettingsJSON`,
  # this one a channel callback), and the first where the un-covered surface
  # is INBOUND — which no widening of the outbound codegen digest would ever
  # reach. Filed as #1787. The bump here is the RULE, not the gate.
  #
  # @min_protocol_version is NOT the same axis and stays at 1: it rises only
  # when old clients can no longer be SERVED, and every client that spoke v1
  # is still served — v1 clients tolerate what v7 clients require.
  @protocol_version 7
  @min_protocol_version 1

  @doc "The protocol version the server currently speaks."
  # A literal (not `pos_integer()`) so the spec matches the success typing of
  # the literal constant under Dialyzer `:underspecs` — the codebase idiom
  # for a constant-returning function (`Grappa.Notify.max_entries/0 :: 64`,
  # `Grappa.IRC.Identifier.max_nick_length/0 :: 30`). A bump edits the spec
  # alongside `@protocol_version`; the spec doubles as the bump tripwire,
  # and now that the bump is routine the tripwire is what keeps it from
  # being done half-way.
  @spec version() :: 7
  def version, do: @protocol_version

  @doc """
  The oldest client protocol version the server still accepts. A client
  declaring below this is refused at the WS handshake with 426.
  """
  @spec min_version() :: 1
  def min_version, do: @min_protocol_version
end
