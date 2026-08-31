// e2e ↔ prod nginx parity tripwires (e2e CSP parity, 2026-06-11).
//
// Both assertions pin behavior that ONLY exists at the nginx layer,
// which ConnTest (Phoenix-level) is structurally blind to and which
// unit suites green right through:
//
// 1. Security headers on the wire. #485 moved the header set OFF nginx
//    into the BEAM (GrappaWeb.Plugs.SecurityHeaders, the single owner);
//    the e2e nginx is now a dumb proxy, so these headers arrive from
//    grappa THROUGH the proxy, byte-identical to prod. This spec turns
//    "does the e2e surface carry prod CSP?" from an archaeology question
//    into a red/green one: if the plug drops a directive the media
//    pipeline depends on, or the proxy strips it, this fails — on BOTH
//    listeners (:80 legacy + :443 push surface). Directive pins are the
//    load-bearing subset, not the full header string: the full string
//    lives in the plug (one source), and mirroring it here would just be
//    a second copy to drift. (`securitypolicyviolation` enforcement
//    coverage is the `_cspGuard` fixture's job — fixtures/test.ts.)
//
// 2. Range round-trip THROUGH the proxy. Controller-side single-range
//    206 landed 2026-06-10 (GrappaWeb.ByteRange — iOS Safari refuses
//    to play video without it), but a proxy that strips/buffers
//    `Range:` would degrade every video seek on prod while ConnTest
//    stays green — same prod-only blind-spot class as the CSP.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
import { uploadViaPicker } from "../fixtures/uploadJourney";

// Directives whose loss has bitten (media-src/worker-src, 6f3327c) or
// would silently disarm the XSS posture the bearer-in-localStorage
// design leans on (default-src/frame-ancestors/base-uri).
const LOAD_BEARING_DIRECTIVES = [
  "default-src 'self'",
  // #607 — the `https:` token must reach the wire (external audio in the
  // docked mini-player); the old "media-src 'self' blob:" pin is a PREFIX
  // of this, so `toContain` would pass silently without the widened token.
  "media-src 'self' blob: https:",
  // #1240 — same prefix trap: the old "img-src 'self' data:" pin is a
  // PREFIX of the widened value, so it must be pinned WITH the `https:`
  // token or a revert would sail through `toContain`. Losing it opens the
  // cross-host image viewer as an EMPTY modal. 1883 added `blob:` in the
  // middle for the picker confirm's thumbnail — pinned as the WHOLE value
  // for the third time and the same reason: every shorter spelling of this
  // directive is a prefix of the longer one.
  "img-src 'self' data: blob: https:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
];

test("nginx parity — prod security-header set served on :80 and :443", async ({ page }) => {
  for (const origin of ["http://nginx-test", "https://nginx-test"]) {
    const res = await page.request.get(`${origin}/`);
    expect(res.status(), `GET ${origin}/`).toBe(200);

    const headers = res.headers();
    const csp = headers["content-security-policy"];
    expect(csp, `${origin} must serve Content-Security-Policy`).toBeTruthy();
    for (const directive of LOAD_BEARING_DIRECTIVES) {
      expect(csp, `${origin} CSP must carry "${directive}"`).toContain(directive);
    }

    expect(headers["x-content-type-options"], origin).toBe("nosniff");
    expect(headers["x-frame-options"], origin).toBe("DENY");
    expect(headers["referrer-policy"], origin).toBe("same-origin");
  }
});

test("nginx parity — ranged GET /uploads/<slug> through the proxy → 206 + content-range", async ({
  page,
}) => {
  const body = readFileSync(fileURLToPath(new URL("../fixtures/upload.txt", import.meta.url)));
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  const { slug } = await uploadViaPicker(
    page,
    { name: "range-probe.txt", mimeType: "text/plain", buffer: body },
    { postTimeout: 10_000 },
  );

  // page.request goes through baseURL = https://nginx-test — the
  // proxy, not grappa directly. bytes=0-3 is a 4-byte slice.
  const res = await page.request.get(`/uploads/${slug}`, {
    headers: { Range: "bytes=0-3" },
  });
  expect(res.status()).toBe(206);
  expect(res.headers()["content-range"]).toBe(`bytes 0-3/${body.length}`);
  expect(res.headers()["accept-ranges"]).toBe("bytes");
  expect((await res.body()).equals(body.subarray(0, 4))).toBe(true);
});
