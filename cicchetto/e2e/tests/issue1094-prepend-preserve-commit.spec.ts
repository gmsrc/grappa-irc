// #1094 — paging older history must not move the rows the operator is reading,
// even when they keep scrolling while the page is on the wire.
//
// The field report (vjt, 2026-08-23): *"salire e ripescare messaggi vecchi
// smuove tutto l'elenco e non è smooth per niente. arrivare in area di fetch
// in sostanza che causa il prelevamento dei vecchi messaggi sposta lo
// scrolltop e quindi sposta i messaggi visualizzati"*.
//
// WHY THIS SPEC EXISTS AND THE UNIT TESTS DO NOT COVER IT. The units
// (`scrollback.test.ts` #1094, `ScrollbackPane.test.tsx` #1094) pin the
// MECHANISM: which instant the geometry is read at, and that the correction
// lands in the same task as the mutation. They cannot pin the OUTCOME, because
// jsdom has no layout engine — every px in them is a `defineProperty`, so a
// change that kept the arithmetic and broke the rendered result would leave
// them green. What the operator reports is rendered geometry, and the only
// oracle for rendered geometry is a real browser.
//
// The oracle here is deliberately NOT frame sampling. A composited-frame probe
// is what measured the original defect (see the issue), but it needs a bespoke
// rAF harness and it answers a question that is inherently one frame wide. The
// durable statement is about an END STATE: pick a row the reader is looking at,
// note where it sits in the viewport, page older history in underneath it, and
// it must still be in the same place. That survives a retry, a slower CI box
// and a different page size.
//
// CP14 B2 already pins the same gesture, but from `scrollTop === 0`: it wheels
// all the way to the top in one throw, so the geometry at the moment the fetch
// is armed and the geometry at the moment it lands are the same numbers, and
// the defect is invisible. THE WHOLE POINT here is that they differ — the
// operator's flick carries on while the request is in flight, which is what an
// operator's flick does.
//
// #1151 (the frozen pane moving 11px for an 18px insertion) is ADJACENT and
// deliberately not folded in: the tolerance below is wide enough to survive
// that residue and narrow enough that the ~150px this issue is about cannot
// hide inside it.

import type { Page } from "@playwright/test";
import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { fetchAllMessagesAsc, setReadCursorToId } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;

// Mirror of ScrollbackPane.LOAD_MORE_THRESHOLD_PX (not exported). Same
// re-declaration + same lockstep caveat as cp14-b2.
const LOAD_MORE_THRESHOLD_PX = 200;

// Where the first wheel parks the reader: inside the threshold, so the fetch
// is armed, but well clear of 0, so there is room left to scroll DURING it.
// The distance between this and 0 is exactly the error the old shape made.
const ARM_AT_PX = 150;

// How long the older page is held on the wire. Long enough to complete a
// second wheel gesture inside it and still leave slack on a loaded CI box.
const FETCH_HOLD_MS = 1_500;

// Anchor drift we accept. Zero is not honest: sub-pixel layout, the row's own
// line-box rounding, and the #1151 residue all live below this. The defect
// this spec guards is ARM_AT_PX wide.
const ANCHOR_TOLERANCE_PX = 12;

async function scrollTop(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    return el.scrollTop;
  });
}

// The id of the first row whose box is fully inside the viewport — the row the
// reader is looking at, and the thing that must not move. Read by id rather
// than by index: the prepend changes every row's index by definition.
async function topVisibleRowId(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    const paneTop = el.getBoundingClientRect().top;
    for (const row of Array.from(
      el.querySelectorAll<HTMLElement>(".scrollback-line[data-msg-id]"),
    )) {
      if (row.getBoundingClientRect().top >= paneTop) {
        const id = row.dataset.msgId;
        if (id !== undefined) return id;
      }
    }
    throw new Error("no fully-visible scrollback row found");
  });
}

// That row's offset from the top of the pane, in viewport px.
async function rowOffsetFromPaneTop(page: Page, msgId: string): Promise<number> {
  return await page.evaluate((id) => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    const row = el.querySelector<HTMLElement>(`.scrollback-line[data-msg-id="${id}"]`);
    if (!row) throw new Error(`anchor row ${id} left the DOM`);
    return row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, msgId);
}

async function wheelOverScrollback(page: Page, deltaY: number): Promise<void> {
  const box = await page.locator('[data-testid="scrollback"]').boundingBox();
  if (!box) throw new Error("scrollback bounding box null");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

test.describe("#1094 — the prepend preserve reads the geometry at the commit", () => {
  // Same tiny viewport as CP14 B1/B2: it guarantees the initial REST page
  // overflows, so there is a scroll position to preserve at all.
  test.use({ viewport: { width: 800, height: 300 } });

  test("an anchor row does not move when older history lands mid-flick", async ({ page }) => {
    const vjt = specUser();

    // Read cursor at the tail before login, exactly as CP14 B2 explains: it
    // is what makes the channel hydrate through the cursor-PRESENT arm and
    // open on the ~50-row read-context page, leaving older rows to fetch.
    const seeded = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, CHANNEL);
    const tail = seeded[seeded.length - 1];
    if (!tail) throw new Error("#1094: seeded corpus is empty");
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, tail.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    const initialCount = await scrollbackLines(page).count();
    // Same precondition guard as CP14 B2: with the whole corpus already in the
    // pane there is no older page to fetch and a green run would mean nothing.
    expect(initialCount).toBeLessThan(seeded.length);

    // Hold the older page on the wire. Installed only NOW: the initial load
    // uses the same `before=` route and delaying it would just slow the setup.
    await page.route("**/api/networks/**/messages?**", async (route) => {
      if (!route.request().url().includes("before=")) {
        await route.continue();
        return;
      }
      await new Promise((r) => setTimeout(r, FETCH_HOLD_MS));
      await route.continue();
    });

    // First flick: land inside the threshold but NOT at the top. This is what
    // arms the fetch, and the geometry here is what the pre-#1094 shape spent.
    const from = await scrollTop(page);
    expect(from).toBeGreaterThan(LOAD_MORE_THRESHOLD_PX);
    await wheelOverScrollback(page, -(from - ARM_AT_PX));
    await expect
      .poll(async () => await scrollTop(page), { timeout: 5_000 })
      .toBeLessThanOrEqual(LOAD_MORE_THRESHOLD_PX);

    // CALIBRATION. Everything below is meaningless if the hold did not take:
    // a fetch that returns instantly leaves no window to scroll inside, the
    // second flick lands after the commit, and both shapes pass. The loading
    // affordance IS the observable that the request is still out — so this
    // arm proves the injected delay AND covers the issue's second half in one
    // assertion. If it ever fails, the spec below is not measuring #1094.
    await expect(page.getByTestId("scrollback-loading-older")).toBeVisible({ timeout: 5_000 });

    // Second flick, WHILE the page is in flight: the operator carries on to
    // the very top. Nothing about this reaches the armed request.
    await wheelOverScrollback(page, -100_000);
    await expect.poll(async () => await scrollTop(page), { timeout: 5_000 }).toBe(0);

    // The row the reader is now looking at, and where it sits. Captured with
    // the fetch still out, so it is the state the commit has to preserve.
    await expect(page.getByTestId("scrollback-loading-older")).toBeVisible();
    const anchorId = await topVisibleRowId(page);
    const before = await rowOffsetFromPaneTop(page, anchorId);

    // Let the page land.
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 15_000 })
      .toBeGreaterThan(initialCount);
    // …and the affordance comes back down with it (the DirectoryPane lesson:
    // a spinner that outlives the commit is worse than none).
    await expect(page.getByTestId("scrollback-loading-older")).toBeHidden({ timeout: 5_000 });

    const after = await rowOffsetFromPaneTop(page, anchorId);

    // THE ASSERTION. Rows were inserted above this one; it must not have
    // moved. The pre-#1094 shape restored to `delta + 150` — the scrollTop the
    // reader had when the gesture crossed the threshold, not the 0 they
    // actually reached — so the anchor came out ~ARM_AT_PX lower than here.
    expect(Math.abs(after - before)).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);

    await page.unroute("**/api/networks/**/messages?**");
  });
});
