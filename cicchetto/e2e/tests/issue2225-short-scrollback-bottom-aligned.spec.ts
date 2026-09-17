// issue 2225 — a short scrollback stacks its rows against the composer, not
// under the floating corner controls.
//
// A fresh query holds a handful of rows, the top chrome of a non-channel pane
// takes no height (#985 floats the lone ☰ over a zero-height row) and the
// buffer is too short to scroll, so with a top-aligned `.scrollback` the only
// rows that exist sat exactly in the band the corner controls cover — vjt's
// iPhone screenshot: timestamp behind the `#`, second row clipped to `…22`,
// then ~1200 device px of empty pane. Ruling (#grappa 2026-09-16): «il testo
// deve iniziare dal basso».
//
// jsdom lays nothing out, so `scrollbackBottomAlign.test.ts` pins only the
// idiom (flex column + `margin-top: auto` on the first child). This is the
// geometry: on a fresh DM holding ONE row, that row's box sits at the pane's
// bottom edge and nowhere near its top; on a fresh, EMPTY query the
// `no messages yet` fallback does the same (the ruling names that case too).
// RED before the fix on both counts (row at y ≈ pane top), GREEN after.
import type { Page } from "@playwright/test";
import {
  composeSend,
  loginAs,
  rowClearance,
  scrollbackLine,
  scrollbackLines,
  selectChannel,
  sidebarWindow,
  waitForDmListenerReady,
} from "../fixtures/cicchettoPage";
import { fetchScrollbackPage, setReadCursorToId } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const DM_PEER_NICK = "t2225-dm-peer";
const EMPTY_PEER_NICK = "t2225-empty-peer";
const FIRST_DM_LINE = "2225 the only row in a fresh query";
const CHANNEL = AUTOJOIN_CHANNELS[0];

// `.scrollback` pads 0.5rem at the bottom; at any root font size this sheet
// ships that is under 16px. A row "at the bottom" therefore ends within this
// many CSS px of the pane's bottom edge, and a row "at the top" would start
// within the same band of the pane's top edge — which is exactly the defect.
const BOTTOM_PADDING_MAX_PX = 16;

// `@webkit` on THIS test and not the other: the defect was reported from an
// iPhone, and the flex/min-height quirks the `.scrollback` comments record
// are WebKit's, so the first-row case runs on the webkit project while the
// empty-state case stays on chromium — one geometry check per engine.
test("issue 2225 @webkit — the first row of a fresh DM sits at the bottom of the pane, not the top", async ({
  page,
}) => {
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await waitForDmListenerReady(page, NETWORK_SLUG);

  const peer = await IrcPeer.connect({ nick: DM_PEER_NICK });
  try {
    await composeSend(page, `/msg ${peer.nick} ${FIRST_DM_LINE}`);
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, peer.nick, { awaitWsReady: false });

    const firstRow = scrollbackLine(page, "privmsg", FIRST_DM_LINE);
    await expect(firstRow).toBeVisible({ timeout: 15_000 });

    // Poll: the row renders and the flex layout settles on separate frames.
    await expect
      .poll(
        async () => {
          const c = await rowClearance(firstRow);
          return c.paneBottomPx - c.rowBottomPx;
        },
        {
          message:
            "the only row of a fresh DM must end at the pane's bottom edge (minus its padding)",
          timeout: 5_000,
        },
      )
      .toBeLessThanOrEqual(BOTTOM_PADDING_MAX_PX);

    const c = await rowClearance(firstRow);
    // Not below the pane either: bottom-aligned, not overflowing.
    expect(
      c.overflowBelowPx,
      `row must not overflow the pane: ${JSON.stringify(c)}`,
    ).toBeLessThanOrEqual(0);
    // And nowhere near the top — the band the corner controls float over.
    // The pane is many rows tall on every project, so "not at the top" is a
    // clear margin, not a sub-pixel call.
    expect(
      c.rowTopPx - c.paneTopPx,
      `row must sit well below the pane's top edge: ${JSON.stringify(c)}`,
    ).toBeGreaterThan(BOTTOM_PADDING_MAX_PX * 4);
  } finally {
    await peer.disconnect("2225 done");
  }
});

test("issue 2225 — the `no messages yet` fallback of an empty query sits at the bottom too", async ({
  page,
}) => {
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await waitForDmListenerReady(page, NETWORK_SLUG);

  const peer = await IrcPeer.connect({ nick: EMPTY_PEER_NICK });
  try {
    // `/query` opens the window without sending anything, so the pane holds
    // only the fallback paragraph.
    await composeSend(page, `/query ${peer.nick}`);
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, peer.nick, { awaitWsReady: false });

    const empty = page.locator(".scrollback-empty");
    await expect(empty).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(
        async () => {
          const c = await rowClearance(empty);
          return c.paneBottomPx - c.rowBottomPx;
        },
        {
          message: "the empty-state line must end at the pane's bottom edge (minus its padding)",
          timeout: 5_000,
        },
      )
      .toBeLessThanOrEqual(BOTTOM_PADDING_MAX_PX);

    const c = await rowClearance(empty);
    expect(c.overflowBelowPx, JSON.stringify(c)).toBeLessThanOrEqual(0);
    expect(c.rowTopPx - c.paneTopPx, JSON.stringify(c)).toBeGreaterThan(BOTTOM_PADDING_MAX_PX * 4);
  } finally {
    await peer.disconnect("2225 done");
  }
});

// The OTHER half of the cure, exercised rather than claimed (vjt's review of
// f2292b08): the auto margin must collapse to 0 the moment the buffer
// overflows, and the crossing itself must not move what the reader is looking
// at. This spec starts on a SHORT pane (the ~50-row tail page of the seeded
// corpus underfills a tall viewport, the #230 precondition), drives ONE
// load-older with the wheel lever #230 established, and asserts two things
// across the boundary: the newest row's box did not move (peluche's jump —
// rows shoved down a viewport by a backlog landing above them — is exactly
// this row moving), and the oldest row is still reachable at scrollTop 0
// (the top-clipping `justify-content: flex-end` would have failed here).
// Both regimes are asserted as PRECONDITIONS so a viewport or row-height
// change fails loudly instead of green-washing a spec that never crossed.

// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;

async function paneGeometry(
  page: Page,
): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number; top: number }> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      top: el.getBoundingClientRect().top,
    };
  });
}

test.describe("issue 2225 — crossing from short to over-full", () => {
  // ~50 rows of the seeded corpus are ~1000px; 1300 tall leaves them
  // underfilled, and the next 50 push the buffer past the pane. Both facts
  // are asserted below, not assumed.
  test.use({ viewport: { width: 800, height: 1300 } });

  test("issue 2225 — a load-older that overflows the pane moves no visible row and keeps the top reachable", async ({
    page,
  }) => {
    const vjt = specUser();
    // Cursor at HEAD → no unread divider → the cold load is the tail-only
    // page, deterministic regardless of what a prior spec left behind.
    const headPage = await fetchScrollbackPage(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(headPage.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const headId = headPage[0]?.id;
    if (!headId) throw new Error("seed page empty — cannot seed the read cursor to head");
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, headId);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const initialCount = await scrollbackLines(page).count();

    // PRECONDITION 1 — short: the pane underfills, nothing to scroll.
    await expect
      .poll(async () => {
        const g = await paneGeometry(page);
        return g.scrollHeight - g.clientHeight;
      })
      .toBeLessThanOrEqual(0);

    // Bottom-aligned while short: the newest row ends at the pane's bottom.
    const newest = scrollbackLines(page).last();
    const before = await rowClearance(newest);
    expect(
      before.paneBottomPx - before.rowBottomPx,
      `newest row must sit at the bottom while short: ${JSON.stringify(before)}`,
    ).toBeLessThanOrEqual(BOTTOM_PADDING_MAX_PX);

    // The crossing: one wheel-up load-older (#230's lever on an underfilled
    // pane — a real wheel event, no native scroll to piggy-back on).
    await page.locator('[data-testid="scrollback"]').hover();
    await page.mouse.wheel(0, -600);
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThan(initialCount);

    // PRECONDITION 2 — over-full: the buffer now exceeds the pane, so the auto
    // margin has collapsed to 0 and this is the regime the CSS comment claims.
    await expect
      .poll(async () => {
        const g = await paneGeometry(page);
        return g.scrollHeight - g.clientHeight;
      })
      .toBeGreaterThan(0);

    // No visible row jumped: the newest row's box is where it was before the
    // older page landed above it. Polled, because the prepend and the scroll
    // restore commit on separate frames (#1094).
    await expect
      .poll(async () => Math.abs((await rowClearance(newest)).rowTopPx - before.rowTopPx), {
        message: "the newest row must not move when older rows land above it",
        timeout: 5_000,
      })
      .toBeLessThanOrEqual(1);

    // The top is still reachable: at scrollTop 0 the OLDEST row's box starts
    // at or below the pane's top edge — nothing is clipped above it.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement;
      el.scrollTop = 0;
    });
    await expect.poll(async () => (await paneGeometry(page)).scrollTop, { timeout: 5_000 }).toBe(0);
    const oldest = await rowClearance(scrollbackLines(page).first());
    expect(
      oldest.overflowAbovePx,
      `oldest row must not be clipped above the pane at scrollTop 0: ${JSON.stringify(oldest)}`,
    ).toBeLessThanOrEqual(0);
  });
});
