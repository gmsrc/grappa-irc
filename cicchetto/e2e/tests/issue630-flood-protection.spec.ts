// GH #630 — inbound flood protection, REAL end-to-end acceptance gate.
//
// Drives the whole throttle → 429 → sever ladder through the LIVE stack in
// ONE user-visible flow, asserting the FRAME (not an internal counter):
//
//   1. a burst within budget is served (the bystander baseline below);
//   2. over budget → the client gets the 429 `rate_limited` frame + a
//      `retry_after_ms` retry hint (asserted on the actual response body);
//   3. sustained flooding SEVERS the web session — the auth bearer is
//      revoked (a reconnect with the old credentials is refused, HTTP 401)
//      and cicchetto drops to the re-login screen with the flood banner;
//   4. THE POINT: a second, well-behaved subject (admin) keeps working
//      normally throughout — A's flood does not become B's outage.
//
// The flood hammers the REST write door (a real metered door) with the
// vjt bearer straight from the page; the shared per-subject budget means
// the sever's effects (user-topic `web_session_severed` event → banner,
// bearer revoke, socket close) land on the live WS all the same. The IRC
// session is deliberately NOT touched — out of scope for a WEB sever.
//
// Isolation: flooding vjt drains only vjt's per-subject bucket, which
// self-heals via refill (dev config 20/s) long before the next spec's
// vjt login; the bystander is a DISTINCT subject (admin), untouched.

import { loginAs } from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { getSeededAdmin, getSeededVjt } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// A metered WRITE both subjects may issue (visitor-parity route, user
// scope → guarded by GrappaWeb.Plugs.RequestBudget). An empty body is
// controller-rejected (422) when ALLOWED — still proof the budget let it
// through — and 429 when over budget, so the status alone discriminates
// "throttled" from "served".
const METERED_WRITE = "/me/settings/notification-prefs";

// Big enough to blow past capacity + the sever threshold even after
// in-burst refill, in one fast wave-batched shot (dev config: capacity
// 200, refill 20/s, sever at 30 over-budget events in 10s).
const FLOOD_COUNT = 1200;
const WAVE = 120;

test("sustained inbound flood 429s then severs the web session; a second subject keeps working", async ({
  page,
  request,
}) => {
  const admin = getSeededAdmin();

  // (4a) Bystander baseline — a metered write on a DIFFERENT subject is
  // served before the flood (not throttled, not revoked).
  const beforeWrite = await request.put(`${GRAPPA_BASE_URL}${METERED_WRITE}`, {
    headers: { authorization: `Bearer ${admin.token}` },
    data: {},
  });
  expect(beforeWrite.status()).not.toBe(429);
  expect(beforeWrite.status()).not.toBe(401);

  // Flooder — a live, authenticated cicchetto page (vjt) with an open WS.
  await loginAs(page, getSeededVjt());

  // Capture the flood bearer BEFORE the sever (cic clears localStorage on
  // logout) so we can prove the OLD credential is refused afterwards.
  const floodToken = await page.evaluate(() => localStorage.getItem("grappa-token"));
  expect(floodToken).toBeTruthy();

  // Flood the metered REST write door with the vjt bearer, wave-batched so
  // the browser's per-origin connection cap doesn't stretch the burst into
  // refill territory. Capture every status + the FIRST 429's parsed body.
  const result = await page.evaluate(
    async ({ url, total, wave }) => {
      const token = localStorage.getItem("grappa-token");
      const statuses: number[] = [];
      let throttleBody: { error?: string; retry_after_ms?: number } | null = null;

      const one = async () => {
        const r = await fetch(url, {
          method: "PUT",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: "{}",
        }).catch(() => null);
        if (r === null) return 0;
        if (r.status === 429 && throttleBody === null) {
          throttleBody = await r.json().catch(() => null);
        }
        return r.status;
      };

      for (let sent = 0; sent < total; sent += wave) {
        const batch = await Promise.all(
          Array.from({ length: Math.min(wave, total - sent) }, one),
        );
        statuses.push(...batch);
      }
      return { statuses, throttleBody };
    },
    { url: METERED_WRITE, total: FLOOD_COUNT, wave: WAVE },
  );

  // (2) The over-budget FRAME: 429 with the snake_case `rate_limited`
  // envelope + a positive retry hint.
  expect(result.statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  expect(result.throttleBody).not.toBeNull();
  expect(result.throttleBody?.error).toBe("rate_limited");
  expect(typeof result.throttleBody?.retry_after_ms).toBe("number");
  expect(result.throttleBody?.retry_after_ms as number).toBeGreaterThan(0);

  // (3a) Sustained flooding severed the session: once the bearer is
  // revoked, in-flight flood requests start coming back 401.
  expect(result.statuses.filter((s) => s === 401).length).toBeGreaterThan(0);

  // (3b) Reconnect with the OLD credentials is refused until re-auth —
  // the revoked bearer no longer authenticates.
  const stale = await request.get(`${GRAPPA_BASE_URL}/me`, {
    headers: { authorization: `Bearer ${floodToken}` },
  });
  expect(stale.status()).toBe(401);

  // (3c) The severed subject is dropped to the re-login screen with the
  // dedicated flood banner (server broadcast the web_session_severed
  // user-topic event before closing the socket).
  await expect(page.getByText(/too fast|disconnected|flood/i)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator(".shell-main")).toBeHidden();

  // (4b) The bystander — a distinct subject — is untouched by the flood:
  // its metered write is still served (not throttled, not revoked) and its
  // session is alive.
  const afterWrite = await request.put(`${GRAPPA_BASE_URL}${METERED_WRITE}`, {
    headers: { authorization: `Bearer ${admin.token}` },
    data: {},
  });
  expect(afterWrite.status()).not.toBe(429);
  expect(afterWrite.status()).not.toBe(401);

  const bystanderMe = await request.get(`${GRAPPA_BASE_URL}/me`, {
    headers: { authorization: `Bearer ${admin.token}` },
  });
  expect(bystanderMe.status()).toBe(200);
});
