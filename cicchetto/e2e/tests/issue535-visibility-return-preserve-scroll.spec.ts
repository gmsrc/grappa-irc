// #535 — returning from an external link must NOT tail-snap a reader who was
// mid-backlog.
//
// Reported (verbatim): "Reading a channel with backlog, opening a link that
// leaves the app (an image linked in channel, from the PWA) and coming back
// drops the reader at the tail instead of where they were reading. Coming back
// should land at the messages still to be read."
//
// Root cause (origin/main c1f8c2a9, reproduced here on e1d7ab66): the
// `isDocumentVisible` false→true effect in ScrollbackPane fired
// `scrollToActivation("tail-only", true)` UNCONDITIONALLY — no `atBottom()`
// gate. A reader following live and a reader parked 400 rows up in backlog got
// the same tail snap.
//
// Fix (this bucket): gate the resume scroll on the follow-state that was in
// effect when the document hid — the SAME `atBottom()` gate the resize
// re-anchor already uses (ScrollbackPane onMount, ~:1495):
//   * atBottom() true  → follow-live reader → keep "tail-only" (#46 resume
//     family). Guarded by the third test below (must NOT regress).
//   * atBottom() false → the reader deliberately left the tail → land on the
//     re-latched unread divider if one renders, else preserve their scrollTop.
//     NEVER tail-snap (owner ruling 2026-07-29: the only legitimate jump to the
//     bottom is the operator's own send in the active window).
//
// This is the "resume ≠ switch" family, one-shot, no latch — the marker branch
// stays scoped by the explicit `atBottom()` condition, so #168's collapse of
// scroll to a single always-bottom authority is NOT re-widened.
//
// Every assertion below is a VISIBLE outcome measured off the live DOM
// (scroll geometry, marker in the viewport, the rendered row) — never a spy,
// never a reload. RED against pre-fix code (unconditional tail snap), GREEN
// once the `atBottom()` gate lands.
//
// ## Fixture shape (matches scroll-on-window-switch / cp14-b1)
//
// 200 DB-seeded rows on (vjt, bahamut-test, #bofh) + an 800×300 viewport so the
// 50-row REST page reliably overflows — without overflow "not at the tail" is
// vacuous. Read cursor is force-seeded per test BEFORE login; afterAll restores
// it to the tail (BUGHUNT-3 cascade rule — a leaked mid-page cursor forks the
// next spec's divider assertions).

import type { Page } from "@playwright/test";
import { loginAs, scrollbackLine, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { fetchScrollbackPage, setReadCursorToId } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Mirror of ScrollbackPane.SCROLL_BOTTOM_THRESHOLD_PX = 50 (not exported; kept
// in lockstep, same as cp14-b1 / scroll-on-window-switch).
const SCROLL_BOTTOM_THRESHOLD_PX = 50;
const REST_PAGE_SIZE = 50;

// Read the live scroll geometry off the [data-testid="scrollback"] container.
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

async function distanceFromBottom(page: Page): Promise<number> {
  const g = await scrollbackGeometry(page);
  return g.scrollHeight - g.scrollTop - g.clientHeight;
}

// A REAL Chromium wheel gesture over the scrollback — the ONLY way to flip
// `atBottom` false: onScroll gates the false-flip on `st < lastScrollTop`
// (a genuine upward scroll), and the settle/loadMore paths gate on a real
// input event. Synthetic `dispatchEvent(new Event("scroll"))` is deliberately
// gated OUT (BUGHUNT-2). Same idiom as cursor-forward-only.spec.ts::scrollByPx.
async function wheelBy(page: Page, deltaY: number): Promise<void> {
  const box = await page.locator('[data-testid="scrollback"]').boundingBox();
  if (!box) throw new Error("scrollback bounding box null");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

// Flip document visibility deterministically. documentVisibility.ts reads BOTH
// `document.visibilityState` AND `document.hasFocus()`, so both are overridden;
// the production listeners' events are dispatched so the Solid signal updates.
// Identical idiom to freshness-on-activation.spec.ts::setTabHidden.
async function setTabHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((isHidden) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (isHidden ? "hidden" : "visible"),
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => !isHidden,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(isHidden ? "blur" : "focus"));
  }, hidden);
  await page.waitForTimeout(150);
}

// Open the per-channel delivery gap (#159): silence live `phx.on("event")` for
// this channel's topic while the socket + every other channel stay live, so a
// message posted during the hidden window is MISSED live and only re-fetched by
// `refreshScrollback` on visibility-return. Same hook freshness-on-activation
// uses to reproduce the socket-stays-open gap.
async function suppressChannelDelivery(page: Page, slug: string, name: string): Promise<void> {
  await page.evaluate(
    ([s, n]) => {
      if (!window.__cic_suppressChannelDeliveryForTests) {
        throw new Error("__cic_suppressChannelDeliveryForTests hook missing");
      }
      window.__cic_suppressChannelDeliveryForTests(s, n);
    },
    [slug, name] as const,
  );
}

test.describe("#535 — visibility-return preserves the mid-backlog reader's position", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test("scrolled-up reader, NO unread divider: return preserves scrollTop, never tail-snaps", async ({
    page,
  }) => {
    const vjt = specUser();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Fully-read channel: seed the cursor to the newest row so NO divider
    // renders (the auto-reset re-seeds #spec-wN with fresh-timestamped rows +
    // clears the cursor; without this seed cic would treat them as live-unread
    // and pin a marker to the top — same precondition as scroll-on-window-switch
    // scenario 1).
    const headPage = await fetchScrollbackPage(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(headPage.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const tailId = headPage[0]?.id;
    if (!tailId) throw new Error("#spec-wN seed page empty — cannot seed cursor to tail");
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, tailId);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    // Fully read → no divider.
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0);

    // Precondition: the pane overflows and starts at the tail (fully read).
    const g0 = await scrollbackGeometry(page);
    expect(g0.scrollHeight).toBeGreaterThan(g0.clientHeight);
    await expect
      .poll(async () => await distanceFromBottom(page))
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);

    // The reader deliberately scrolls UP into backlog (a REAL wheel gesture →
    // atBottom flips false). Stay well clear of the top so loadMore
    // (LOAD_MORE_THRESHOLD_PX=200) doesn't churn the buffer.
    await wheelBy(page, -600);
    await expect.poll(async () => await distanceFromBottom(page)).toBeGreaterThan(200);
    const before = await scrollbackGeometry(page);
    expect(before.scrollTop).toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);

    // Leave the app (open the image link in an external tab) and come back.
    await setTabHidden(page, true);
    await setTabHidden(page, false);
    // Let the visibility effect + refreshScrollback settle; pre-fix the tail
    // snap lands within the rAF×2, so this window is generous enough to catch it.
    await page.waitForTimeout(700);

    // Contract: the reader is STILL where they were reading — scrollTop
    // preserved, NOT snapped to the bottom. RED pre-fix: scrollTop jumped to
    // the max and distance collapsed to <= threshold.
    const after = await scrollbackGeometry(page);
    expect(after.scrollHeight - after.scrollTop - after.clientHeight).toBeGreaterThan(200);
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(
      SCROLL_BOTTOM_THRESHOLD_PX,
    );
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0);
  });

  test("scrolled-up reader, unread divider present: return lands ON the divider, never tail-snaps", async ({
    page,
  }) => {
    const vjt = specUser();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Seed a cursor 25 rows from the tail so an unread divider injects mid-page
    // (same shape as scroll-on-window-switch scenario 3).
    const page0 = await fetchScrollbackPage(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const cursorRow = page0[25];
    if (!cursorRow) throw new Error("seeded page too short for cursor placement");
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, cursorRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    const marker = page.locator('[data-testid="unread-marker"]');
    await expect(marker).toHaveCount(1);

    // Cold-mount jumped to the divider (atBottom false). The reader then scrolls
    // UP ABOVE the divider (re-reading older context) — a real wheel gesture.
    // Because they scroll above the cursor, the browser blur-arm cursor write is
    // a no-op (advance-only), so the divider stays put at the seeded position.
    const g = await scrollbackGeometry(page);
    expect(g.scrollHeight).toBeGreaterThan(g.clientHeight);
    await wheelBy(page, -400);
    await expect.poll(async () => await distanceFromBottom(page)).toBeGreaterThan(200);

    // Leave the app and come back.
    await setTabHidden(page, true);
    await setTabHidden(page, false);
    await page.waitForTimeout(700);

    // Contract: return lands the reader ON the re-latched unread divider —
    // "the messages still to be read" — NOT at the tail. The marker is
    // on-screen in the upper region (block:"start"); distance-to-bottom is
    // ABOVE threshold. RED pre-fix: the tail snap pushed the divider off the
    // top and distance collapsed to <= threshold.
    await expect(marker).toHaveCount(1);
    await expect(marker).toBeInViewport();
    await expect
      .poll(async () => await distanceFromBottom(page))
      .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);
    const markerOffset = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="scrollback"]') as HTMLElement | null;
      const m = document.querySelector('[data-testid="unread-marker"]') as HTMLElement | null;
      if (!el || !m) throw new Error("scrollback/marker not found");
      return m.getBoundingClientRect().top - el.getBoundingClientRect().top;
    });
    expect(markerOffset).toBeGreaterThanOrEqual(-5);
    expect(markerOffset).toBeLessThan(g.clientHeight / 2);
  });

  test("follow-live reader (at the tail): return still snaps to the newest row (#46 preserved)", async ({
    page,
  }) => {
    const vjt = specUser();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Fully read → focus lands at the tail, atBottom stays true (no scroll up).
    const headPage = await fetchScrollbackPage(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(headPage.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const tailId = headPage[0]?.id;
    if (!tailId) throw new Error("#spec-wN seed page empty — cannot seed cursor to tail");
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, tailId);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    await expect
      .poll(async () => await distanceFromBottom(page))
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);

    const peer = await IrcPeer.connect({ nick: "vis535-peer" });
    try {
      await peer.join(CHANNEL);

      // Leave the app; a new message arrives while backgrounded.
      await setTabHidden(page, true);
      const arrived = `msg-535-follow-live ${Date.now()}`;
      peer.privmsg(CHANNEL, arrived);
      await page.waitForTimeout(400);

      // Come back. The follow-live reader must be pulled to the NEW tail — this
      // is exactly the #46 resume behaviour the gate must NOT break.
      await setTabHidden(page, false);

      const line = scrollbackLine(page, "privmsg", arrived);
      await expect(line).toBeVisible({ timeout: 10_000 });
      await expect(line).toBeInViewport();
      await expect
        .poll(async () => await distanceFromBottom(page))
        .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
    } finally {
      await peer.disconnect("#535 follow-live test done");
    }
  });

  test("scrolled-up reader, messages missed while hidden: return neither tail-snaps nor strands at the top", async ({
    page,
  }) => {
    const vjt = specUser();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Fully read → no divider; the reader will scroll up into read backlog.
    const headPage = await fetchScrollbackPage(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(headPage.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const tailId = headPage[0]?.id;
    if (!tailId) throw new Error("#spec-wN seed page empty — cannot seed cursor to tail");
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, tailId);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    await expect
      .poll(async () => await distanceFromBottom(page))
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);

    // Reader scrolls up into backlog (real wheel → atBottom false).
    await wheelBy(page, -600);
    await expect.poll(async () => await distanceFromBottom(page)).toBeGreaterThan(200);
    const before = await scrollbackGeometry(page);
    expect(before.scrollTop).toBeGreaterThan(200);

    const peer = await IrcPeer.connect({ nick: "vis535-gap-peer" });
    try {
      await peer.join(CHANNEL);

      // Open the #159 per-channel gap, hide the tab, and post while hidden —
      // this cic MISSES the rows live, so `refreshScrollback` on return is the
      // one that appends them (an async rows() recompute → <For> DOM recreation,
      // the exact co-trigger the fix's "preserve" branch must survive, not just
      // the synchronous marker re-latch).
      await suppressChannelDelivery(page, NETWORK_SLUG, CHANNEL);
      await setTabHidden(page, true);
      const during = `msg-535-missed-during-hide ${Date.now()}`;
      peer.privmsg(CHANNEL, during);
      await page.waitForTimeout(600);
      // Gap is real: not rendered yet.
      await expect(scrollbackLine(page, "privmsg", during)).toHaveCount(0);

      // Come back → refreshScrollback fetches + appends the missed row.
      await setTabHidden(page, false);
      // Wait until the refresh append has actually landed (DOM recreated).
      await expect(scrollbackLine(page, "privmsg", during)).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(300);

      // Contract: the reader is left roughly where they were reading — neither
      // yanked to the tail (the #535 bug) NOR stranded at the top of the buffer
      // (the co-trigger the review flagged). scrollTop stays close to `before`
      // (a small shift for the appended tail rows is fine; a tail-snap jumps it
      // to the max, a strand collapses it to ~0).
      const after = await scrollbackGeometry(page);
      expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThan(300);
      expect(after.scrollHeight - after.scrollTop - after.clientHeight).toBeGreaterThan(200);
    } finally {
      await peer.disconnect("#535 gap test done");
    }
  });
});
