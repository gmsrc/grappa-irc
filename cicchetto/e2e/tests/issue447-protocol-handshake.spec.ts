// #447 — protocol version handshake + unauthenticated /api/config
// discovery, proven end-to-end THROUGH the nginx-test proxy (the same
// single-source `locations-api.conf` snippet prod uses), so the nginx
// allowlist trap is covered too: /api/config rides the existing `api`
// alt, and /socket rides its own block.
//
// The load-bearing distinction of #447 is that a too-old client gets a
// clean 426 Upgrade Required, NOT the opaque 403 an auth failure gets,
// NOT an accepted socket fed frames it will mangle. A browser `WebSocket`
// hides the handshake HTTP status, so we drive the upgrade URL with the
// APIRequestContext (`request.get`) instead: the endpoint's socket
// dispatch runs `UserSocket.connect/3` on any GET to /socket/websocket
// (the version check happens BEFORE the WS upgrade), so the raw HTTP
// status is readable — 426 for a below-floor client, 403 for a
// current-version-but-no-token client. The values are read from
// /api/config itself, never hardcoded, so the spec tracks the server
// constants.

import { expect, test } from "../fixtures/test";

// Phoenix's serializer negotiation runs BEFORE UserSocket.connect/3 and
// rejects a GET whose `vsn` matches no serializer — so the probe must
// carry a valid transport `vsn` (like phoenix.js appends) to reach the
// protocol-version gate at all. This is the phoenix transport protocol
// version, distinct from our app `client_proto` (that separation is the
// whole reason #447 did not overload `vsn`).
const PHX_VSN = "2.0.0";

test.describe("#447 protocol handshake + /api/config discovery", () => {
  test("GET /api/config — unauthenticated, snake_case, publishes both version floors", async ({
    request,
  }) => {
    const res = await request.get("/api/config");
    expect(res.status()).toBe(200);

    const body = await res.json();
    // Present + well-typed.
    expect(typeof body.protocol_version).toBe("number");
    expect(typeof body.min_protocol_version).toBe("number");
    expect(body.server).toBe("grappa");
    expect(typeof body.version).toBe("string");
    // Floor invariant: the server can always speak its own minimum.
    expect(body.min_protocol_version).toBeLessThanOrEqual(body.protocol_version);
    // snake_case is the whole contract — no camelCase island (the #447
    // deliberate divergence from the issue's TS-idiom spelling).
    expect(body).not.toHaveProperty("protocolVersion");
    expect(body).not.toHaveProperty("minProtocolVersion");
  });

  // #1290 — the push-encoding capability, proven through the same
  // unauthenticated door. It exists because the switch off the pre-RFC
  // `aesgcm` drafts moves nothing on the WebSocket wire, so it does not
  // bump `protocol_version`, and gating on the release string is
  // forbidden: a third-party client holding an undecryptable payload
  // otherwise cannot tell an old server from its own broken decryptor.
  //
  // #1393d — that still holds, and the boundary is now worth stating,
  // because `protocol_version` bumps on EVERY wire-shape change since
  // 2026-08-21, additive included (docs/CLIENT_PROTOCOL.md §2a). "Wire
  // shape" means the generated schema — what `mix grappa.wire_pin` takes
  // its digest over. A content coding for push payloads is not in it, so
  // this capability is still a capability and not a version, and the
  // reason above is the reason, not an inference from the old
  // additive-means-no-bump rule that #1393d withdrew.
  test("GET /api/config — publishes the push content coding capability", async ({ request }) => {
    const res = await request.get("/api/config");
    expect(res.status()).toBe(200);

    const body = await res.json();
    // Hardcoded on purpose, unlike the version numbers above: this is the
    // RFC 8291 content coding itself, not a constant that moves. A server
    // answering anything else cannot deliver a self-contained payload,
    // which is exactly what a client is meant to check for.
    expect(body.push_content_encoding).toBe("aes128gcm");
    expect(body).not.toHaveProperty("pushContentEncoding");
  });

  test("WS handshake below the floor → 426 Upgrade Required (NOT an accepted socket)", async ({
    request,
  }) => {
    const { min_protocol_version } = await (await request.get("/api/config")).json();
    const tooOld = min_protocol_version - 1;

    const res = await request.get(`/socket/websocket?client_proto=${tooOld}&vsn=${PHX_VSN}`);

    expect(res.status()).toBe(426);
    // The body names the floor so a client learns WHY it was refused.
    const body = await res.json();
    expect(body.error).toBe("upgrade_required");
    expect(body.min_protocol_version).toBe(min_protocol_version);
  });

  test("WS handshake at a current version but no token → 403 (auth-fail is DISTINCT from 426)", async ({
    request,
  }) => {
    // The version passes the floor, so the gate is satisfied and the
    // connect falls through to auth — which fails (no bearer). Proves the
    // two failures are distinct on the wire: 403 here vs 426 above. This
    // is the part that "breaks in silence" if the version reject collapses
    // into the auth reject.
    const { min_protocol_version } = await (await request.get("/api/config")).json();

    const res = await request.get(
      `/socket/websocket?client_proto=${min_protocol_version}&vsn=${PHX_VSN}`,
    );

    expect(res.status()).toBe(403);
  });

  test("WS handshake with NO client_proto → treated as current (403 auth-fail, NOT 426)", async ({
    request,
  }) => {
    // The absent-is-current guarantee, proven at the handshake layer: an
    // absent version falls through to auth (403) and never trips the 426
    // upgrade path. If absent were mis-treated as too-old, this would be 426.
    //
    // #1379 narrowed who this covers. It was written for "cicchetto +
    // shottino, which declare no version"; cicchetto now declares
    // (`socket.ts` CLIENT_PROTOCOL_VERSION), so the un-declaring clients are
    // shottino and any third party that skipped the negotiation. The
    // guarantee is unchanged and still has holders — but it is no longer what
    // keeps the reference client connecting, which is the point of #1379.
    const res = await request.get(`/socket/websocket?vsn=${PHX_VSN}`);

    expect(res.status()).toBe(403);
  });
});
