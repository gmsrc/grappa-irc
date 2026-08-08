// #1061 acceptance 4 — "an e2e test that simulates `navigator.onLine === false`
// (and the `offline` event) and asserts we do absolutely nothing — no connect
// attempt, no scheduled retry — across the foreground/background transitions in
// (1). This is an explicit requirement, not a nice-to-have."
//
// WHAT IS ACTUALLY OBSERVED. Not a signal, not a counter cic maintains about
// itself: `page.on("websocket")` fires on every real WebSocket the browser
// opens. So "no connect attempt" is measured at the browser, one rung below
// anything the fix could accidentally satisfy by lying to itself. A retry
// LADDER, likewise, is not asserted by reading a timer — it is asserted by
// waiting out the window in which the ladder's own rungs would have fired
// (phoenix's default `reconnectAfterMs` is [10,50,100,150,200,250,500,1000,
// 2000] then 5s steady, so 2.5s of quiet is eight rungs that did not happen)
// and finding the count unmoved.
//
// ── WHY EVERY NEGATIVE HERE IS PAIRED, and why that is not decoration ──
//
// A spec that only asserts "nothing happened" passes just as happily when the
// gesture it made was inert — a stubbed event nobody listens to, a page that
// never finished booting. #1019 removed a backgrounding negative for exactly
// that reason: the premise could not be established, so the green meant
// nothing. Every negative below is therefore followed by the SAME gesture
// under the ONE changed condition (connectivity), which must produce a
// connection. If the stub were inert, the paired positive fails and the spec
// goes red — the assertions cannot both be satisfied by a dead harness.
//
// ── ON STUBBING `navigator.onLine` RATHER THAN GOING REALLY OFFLINE ──
//
// Test 2 uses Playwright's REAL `context.setOffline()`: genuinely no network,
// a genuine `offline` event, a genuinely false `navigator.onLine`. That is the
// stronger instrument and it is used wherever it can be.
//
// It cannot be used for test 1, because a cold start that BEGINS offline still
// has to load the app, and the service worker has no `fetch` handler to serve
// it from cache. A page that never loads tests nothing. So test 1 stubs the
// one input the guard reads. That stub is not a proxy for the behaviour under
// test — it IS the guard's input — and its liveness is proved by the paired
// positive rather than assumed.

import { expect, test } from "../fixtures/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt } from "../fixtures/seedData";

// Eight rungs of phoenix's default backoff ladder. Long enough that a client
// which resumed retrying would have done so many times over; short enough not
// to pad the suite.
const LADDER_SETTLE_MS = 2500;

type PageLike = Parameters<typeof loginAs>[0];

/** Count every app WebSocket the browser opens. Attach BEFORE `goto`. */
function countAppSockets(page: PageLike): () => number {
  let opened = 0;
  page.on("websocket", (ws) => {
    if (ws.url().includes("/socket")) opened++;
  });
  return () => opened;
}

/**
 * Drive the two inputs the #254 visibility kick reads. `visibilityState` has
 * no setter, so the property is redefined and the production event dispatched
 * — the same idiom as `freshness-on-activation`'s `setTabHidden`.
 */
async function setVisibility(page: PageLike, state: "visible" | "hidden"): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => s === "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(s === "visible" ? "focus" : "blur"));
  }, state);
}

async function backgroundAndForeground(page: PageLike): Promise<void> {
  await setVisibility(page, "hidden");
  await setVisibility(page, "visible");
}

test("cold start offline opens no socket at all, across foreground/background transitions (#1061)", async ({
  page,
}) => {
  const vjt = getSeededVjt();

  // Offline BEFORE any page script runs: connectivity.ts seeds its signal from
  // `navigator.onLine` at module-evaluation time, so this is a boot that
  // begins offline rather than one told about it afterwards.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
  });
  const sockets = countAppSockets(page);

  await loginAs(page, vjt);

  // The shell is up — REST is untouched by the stub, which is the point: the
  // app is fully alive and has simply been told the network is dead.
  await page.waitForTimeout(LADDER_SETTLE_MS);
  expect(sockets(), "a cold start that begins offline must not dial").toBe(0);

  // Foreground once. This is the reported regression: pre-fix, one
  // visibilitychange→visible re-armed phoenix's ladder for good, because the
  // `offline` event that would halt it again has already fired (or, on a cold
  // start, never fires at all).
  await setVisibility(page, "visible");
  await page.waitForTimeout(LADDER_SETTLE_MS);
  expect(sockets(), "one foregrounding must not un-do the offline halt").toBe(0);

  // Background and foreground twice more — nothing accumulates either.
  await backgroundAndForeground(page);
  await backgroundAndForeground(page);
  await page.waitForTimeout(LADDER_SETTLE_MS);
  expect(sockets(), "repeated transitions must not accumulate attempts").toBe(0);

  // ── The paired positive. Same app, same page, same stubbed transitions;
  // the ONLY thing that changes is connectivity. If the harness above were
  // inert this cannot pass, so the three zeroes above are load-bearing.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
    window.dispatchEvent(new Event("online"));
  });
  await expect
    .poll(sockets, { message: "the network returned — suppression must not be stranding" })
    .toBeGreaterThan(0);
});

test("a warm session taken really offline stays silent until the network returns (#1061)", async ({
  page,
  context,
}) => {
  const vjt = getSeededVjt();
  const sockets = countAppSockets(page);

  await loginAs(page, vjt);
  await expect
    .poll(sockets, { message: "the app connects normally when online" })
    .toBeGreaterThan(0);

  // ── Premise check for the visibility stub, taken while ONLINE. Drop the
  // socket and hold it down, then make the SAME stubbed transition the
  // negatives below rely on: it must reconnect. This proves the stub reaches
  // the #254 handler, and doubles as a no-regression check on that handler.
  await page.evaluate(async () => {
    const drop = (window as unknown as { __cic_dropSocketForTests?: () => Promise<void> })
      .__cic_dropSocketForTests;
    if (!drop) throw new Error("__cic_dropSocketForTests hook missing");
    await drop();
  });
  const beforeKick = sockets();
  await setVisibility(page, "visible");
  await expect
    .poll(sockets, {
      message: "the visibility kick must be live for the negatives to mean anything",
    })
    .toBeGreaterThan(beforeKick);

  // ── Now genuinely offline: a real `offline` event, a real false
  // `navigator.onLine`, a real dead network. No stub involved.
  await context.setOffline(true);
  await page.waitForTimeout(LADDER_SETTLE_MS);
  const whileOffline = sockets();

  await backgroundAndForeground(page);
  await setVisibility(page, "visible");
  await backgroundAndForeground(page);
  await page.waitForTimeout(LADDER_SETTLE_MS);
  expect(sockets(), "an offline device must dial nothing, however often it is foregrounded").toBe(
    whileOffline,
  );

  // ── Paired positive again: the real network comes back.
  await context.setOffline(false);
  await expect
    .poll(sockets, { message: "the halt must lift the moment connectivity returns" })
    .toBeGreaterThan(whileOffline);
});
