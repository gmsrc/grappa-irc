// Issue #168 — scroll authority: after a SEND the pane must stay pinned
// at the BOTTOM, never yank up to the unread divider.
//
// ## The regression (P0)
//
// The #163/#161/#156 unread-anchor cluster left TWO scrollTop authorities
// racing: the always-bottom follow AND a scroll-to-unread-marker anchor
// (`scrollToActivation`'s marker branch + the length-effect's
// `!markerScrolled` branch). On activation into a channel with unread the
// marker anchor won and parked the viewport mid-pane (atBottom=false), so a
// subsequent SEND did NOT follow to the tail — the just-sent line landed
// off-screen at the bottom while the view stayed stuck on the divider.
//
// ## Final scope (vjt + Mez, #168)
//
// ALWAYS scroll-to-bottom. No event-type branching. irssi-shape: new
// content lands at the bottom, the operator PAGES UP MANUALLY to re-read.
// The unread DIVIDER still renders (frozen-display contract, DESIGN_NOTES
// 2026-06-08) but is NO LONGER a scroll anchor. mark-all-read falls out for
// free — reaching the tail on send advances the cursor via the existing
// send-optimistic path, collapsing the divider.
//
// ## What this spec pins
//
// Seed a mid-page read cursor on `#bofh` (25 rows from the tail) so an
// unread divider is present on first focus. Then SEND a line and assert:
//   (a) the pane is pinned at the BOTTOM (distance-to-tail <= threshold),
//   (b) the just-sent line is IN the viewport (did NOT jump to the marker),
//   (c) unread clears — the divider collapses (cursor advanced to the tail).
//
// RED pre-fix: the marker anchor parked the view mid-pane; after the send
// the distance-to-tail stays well above threshold and the sent line is
// off-screen. GREEN post-fix: activation lands at the tail, the send
// follows, the sent line is visible at the bottom, the divider is gone.
//
// Harness mirrors cp14-b1-scroll-marker-vs-bottom (DB-seeded 200-row
// `#bofh` via the e2e seeder sidecar; tiny 800×300 viewport so the 50-row
// REST page overflows and scroll geometry is measurable).

import type { Page } from "@playwright/test";
import {
  composeSend,
  loginAs,
  pageScrollbackUp,
  scrollbackDistanceFromBottom,
  scrollbackLines,
  selectChannel,
  waitForScrollbackRefreshed,
} from "../fixtures/cicchettoPage";
import { fetchScrollbackPage, setReadCursorToId } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Mirror of ScrollbackPane.SCROLL_BOTTOM_THRESHOLD_PX = 50 (not exported;
// kept in lockstep by hand — same as cp14-b1).
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;

async function scrollbackGeometry(
  page: Page,
): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });
}

// Seed the SERVER-side read cursor at the given message id (server-owned
// post-CP29 R-1..R-4; cic hydrates from the `/me` envelope on cold load).
// Delegates to the shared `setReadCursorToId`, which hits the TEST-ONLY
// force endpoint (`ReadCursor.force_set/4`) — the production endpoint is
// advance-only since #233, so a mid-page (backward) seed through it would
// be clamped to the tail a prior spec left behind and no divider would
// render.
test.describe("issue #168 — send pins to bottom, never jumps to the unread marker", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test("unread divider present → send stays at bottom, divider clears", async ({ page }) => {
    const vjt = specUser();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Seed a cursor 25 rows from the tail → an unread divider is injected
    // mid-page on first focus (25 unread rows, same shape as cp14-b1 sc.2).
    const page0 = await fetchScrollbackPage(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const cursorRow = page0[25];
    if (!cursorRow) throw new Error("seeded page too short for cursor placement");
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, cursorRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    // #552 — await the join-ok REST backfill so its late DOM recreation can't
    // undo the send-snap under full-gate load (see waitForScrollbackRefreshed).
    await waitForScrollbackRefreshed(page, NETWORK_SLUG, CHANNEL);

    // REST page landed + the divider rendered (frozen-display contract).
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(1);

    // Sanity: the pane overflows (else the bottom assertions are vacuous).
    const g = await scrollbackGeometry(page);
    expect(g.scrollHeight).toBeGreaterThan(g.clientHeight);

    // SEND a uniquely-identifiable line to THIS channel.
    const marker = `#168 pin-to-bottom ${Date.now()}`;
    await composeSend(page, marker);

    const sentLine = scrollbackLines(page).filter({ hasText: marker });
    await expect(sentLine).toHaveCount(1, { timeout: 10_000 });

    // (a) Pane is pinned at the BOTTOM after the send. RED pre-fix: the
    // marker anchor parked the view mid-pane and the send did not follow,
    // so distance-to-tail stayed well above threshold.
    await expect
      .poll(async () => (await scrollbackDistanceFromBottom(page)) ?? 999)
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);

    // (b) The just-sent line is visible — the view did NOT jump to / stay
    // stuck at the unread divider (which sits above the fold). RED pre-fix:
    // the sent line rendered off-screen at the bottom, not in the viewport.
    await expect(sentLine).toBeInViewport();

    // (c) Unread clears as a free consequence of reaching the tail — the
    // send-optimistic cursor advance collapses the divider (no separate
    // "mark read" write). Divider gone from the DOM.
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0, { timeout: 5_000 });
  });

  test("operator paged UP → send snaps back to the bottom (unconditional)", async ({ page }) => {
    const vjt = specUser();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Mid-page cursor → divider present, pane overflows.
    const page0 = await fetchScrollbackPage(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const cursorRow = page0[25];
    if (!cursorRow) throw new Error("seeded page too short for cursor placement");
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, cursorRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    // #552 — await the join-ok REST backfill so its late DOM recreation can't
    // undo the send-snap under full-gate load (see waitForScrollbackRefreshed).
    await waitForScrollbackRefreshed(page, NETWORK_SLUG, CHANNEL);
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    // Cold-mount into an unread channel now lands on the MARKER, not the tail
    // (#168 completion, 2026-07-03b — vjt point-2 reversed the #46
    // cold-mount-tail wontfix). So activation already sits ABOVE the fold.
    await expect
      .poll(async () => (await scrollbackDistanceFromBottom(page)) ?? 0)
      .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);

    // Operator PAGES UP with a real wheel gesture. This ALSO clears the
    // marker-activation latch (arms the operator-input gate), so the subsequent
    // send goes through the normal follow path. A programmatic scrollTop set
    // would not arm the gate; the wheel event marks a genuine operator scroll.
    //
    // #1336 — the gesture must have LANDED before the send. This used to wheel
    // inside the poll below, which returned on its first evaluation because the
    // pane was already 339px above the tail on the marker: the `> 50` was true
    // of a pane nobody had moved, and the wheel's scroll arrived later, inside
    // the send window, where it disarms the follow intent and freezes the pane.
    await pageScrollbackUp(page, 4000, 5_000);
    await expect
      .poll(async () => (await scrollbackDistanceFromBottom(page)) ?? 0)
      .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);

    // SEND — must snap back to the bottom UNCONDITIONALLY (issue #168 asks:
    // "on sending a message the list must scroll to the bottom
    // unconditionally"), even though the operator had paged up.
    const marker = `#168 unconditional ${Date.now()}`;
    await composeSend(page, marker);

    const sentLine = scrollbackLines(page).filter({ hasText: marker });
    await expect(sentLine).toHaveCount(1, { timeout: 10_000 });
    await expect
      .poll(async () => (await scrollbackDistanceFromBottom(page)) ?? 999)
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
    await expect(sentLine).toBeInViewport();
  });
});
