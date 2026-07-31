// Issue #580 — own-send scroll authority must be INDEPENDENT of the POST.
//
// ## The field report (P0, intermittent)
//
// "own send sometimes does not scroll the list — the bottom-snap is gated on
// the POST resolving, not on the send." Pre-fix, `scrollback.sendMessage`
// published the ONLY scroll signal (`lastOwnSend`) AFTER `await
// apiSendMessage(...)`. That single signal drove BOTH the network-dependent
// work (divider re-latch + cursor advance, which genuinely need the persisted
// row id) AND the network-INDEPENDENT bottom-snap. So a slow / failed POST
// left the pane parked while the WS echo rendered the row.
//
// ## The fix (#580)
//
// Split the two concerns. `ownSendSubmitted` is published SYNCHRONOUSLY at
// submit time (before the await) and drives the bottom-snap + follow-state
// reset — the response to the operator pressing enter, independent of the
// network outcome. `lastOwnSend` stays post-resolve for the divider re-latch.
//
// ## What this spec pins (the discriminating RENDER proof)
//
// The vitest suite proves the TRIGGER fires before the POST. This proves the
// RENDER: even when the send POST FAILS at the client (case 1 — the server
// accepted it, so the row still arrives over WS), the pane SNAPS to the
// bottom and the just-sent line is visible.
//
// A fetch wrapper (addInitScript) forwards the send POST to the server —
// which persists + WS-broadcasts the row — then rejects, so the client's
// `apiSendMessage` sees a failure. RED pre-fix: `setLastOwnSend` sits after
// the throwing await, never runs, the pane stays parked on the unread marker
// (distance-to-tail stays above threshold) while the WS-echoed line renders
// off-screen. GREEN post-fix: `setOwnSendSubmitted` fired before the await, so
// the pane snaps to the tail regardless of the POST outcome.
//
// Harness mirrors issue168-scroll-authority (DB-seeded 200-row `#bofh`; tiny
// 800×300 viewport so the REST page overflows and scroll geometry is
// measurable; mid-page cursor so cold-mount lands on the marker, above the
// fold).

import { test, expect } from "../fixtures/test";
import { type Page } from "@playwright/test";
import {
  composeTextarea,
  loginAs,
  scrollbackLines,
  selectChannel,
  waitForScrollbackRefreshed,
} from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail, setReadCursorToId } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Mirror of ScrollbackPane.SCROLL_BOTTOM_THRESHOLD_PX = 50 (not exported;
// kept in lockstep by hand — same as issue168 / cp14-b1).
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;

async function distanceToBottom(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  });
}

// Latest REST page in wire shape (DESC by server_time) — used to pick a known
// message id for the mid-page cursor seed (mirror of issue168).
async function fetchScrollbackPage(
  token: string,
  channel: string,
): Promise<Array<{ id: number }>> {
  const url = `http://grappa-test:4000/networks/${encodeURIComponent(
    NETWORK_SLUG,
  )}/channels/${encodeURIComponent(channel)}/messages`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`fetchScrollbackPage: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Array<{ id: number }>;
}

// Test-only force endpoint (ReadCursor.force_set/4) — the production endpoint
// is advance-only (#233), so a backward mid-page seed must go through force.
async function seedCursor(channel: string, messageId: number): Promise<void> {
  const vjt = getSeededVjt();
  await setReadCursorToId(vjt.token, NETWORK_SLUG, channel, messageId);
}

test.describe("issue #580 — own send snaps to the bottom independent of the POST", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  // The mid-page cursor persists on the shared seeded vjt across spec
  // boundaries (last-write-wins). Restore to the tail so downstream #bofh
  // specs inherit a fully-read channel (mirror of issue168).
  test.afterAll(async () => {
    const vjt = getSeededVjt();
    if (!CHANNEL) return;
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("send whose POST fails still snaps to the bottom (case 1)", async ({ page }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Fetch-wrap: the send POST reaches the server (which persists +
    // WS-broadcasts the row) but the CLIENT sees a failure — the #580 case-1
    // "server accepted, client POST dropped" shape. Only the send POST is
    // intercepted; every other request (login, REST GETs, read-cursor POST)
    // passes through untouched.
    await page.addInitScript(() => {
      const orig = window.fetch.bind(window);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        if (method === "POST" && /\/channels\/[^/]+\/messages(\?|$)/.test(url)) {
          // Forward the real request so the server broadcasts the row over WS,
          // THEN reject so apiSendMessage sees a failed POST.
          try {
            await orig(input, init);
          } catch {
            // even a genuinely failed forward still simulates the client
            // failure — swallow and reject below.
          }
          throw new TypeError("#580 simulated send POST failure");
        }
        return orig(input, init);
      };
    });

    // Mid-page cursor → cold-mount lands on the unread marker (above the fold),
    // so distance-to-tail starts ABOVE threshold (mirror of issue168).
    const page0 = await fetchScrollbackPage(vjt.token, CHANNEL);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const cursorRow = page0[25];
    if (!cursorRow) throw new Error("seeded page too short for cursor placement");
    await seedCursor(CHANNEL, cursorRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await waitForScrollbackRefreshed(page, NETWORK_SLUG, CHANNEL);

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(1);

    // Reading history: cold-mount parked the view on the marker, above the fold.
    await expect
      .poll(async () => await distanceToBottom(page))
      .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);

    // SEND — the POST will fail client-side, but the server broadcasts the row
    // over WS. Send manually (composeSend awaits a draft-clear that a failed
    // POST never produces); we assert on scroll geometry + the WS-echoed line,
    // not on the textarea.
    const marker = `#580 snap-on-fail ${Date.now()}`;
    const ta = composeTextarea(page);
    await ta.fill(marker);
    await ta.press("Enter");

    // The WS echo renders the row despite the failed POST.
    const sentLine = scrollbackLines(page).filter({ hasText: marker });
    await expect(sentLine).toHaveCount(1, { timeout: 10_000 });

    // The pane snapped to the BOTTOM at submit time — NOT hostage to the POST.
    // RED pre-fix: the snap sat after the throwing await, so the view stayed
    // parked on the marker and distance-to-tail stayed above threshold.
    await expect.poll(async () => await distanceToBottom(page)).toBeLessThanOrEqual(
      SCROLL_BOTTOM_THRESHOLD_PX,
    );
    await expect(sentLine).toBeInViewport();
  });
});
