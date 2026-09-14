// Issue 1738 — after a send the scrollback comes to rest SHORT of its own
// tail: the sent line is flush against the chrome below it and the pane can
// still be hand-scrolled further down.
//
// ## What this spec is FOR, and it is not a cure
//
// It is the measurement issue 1738 was never given. The report is visual, from
// an iPhone, and its falsifiable content is one number — the residual
// `scrollHeight - scrollTop - clientHeight` the pane rests at once a send has
// settled. "It can still be scrolled further by hand" IS that number being
// positive; nothing else in the report distinguishes the defect from a taste
// call about spacing.
//
// ## Why it is not `issue2031-send-with-marker-row-clipped.spec.ts`
//
// That spec measures the SAME write on the SAME platform and is the reason the
// mechanism is known. It differs in its precondition and in what it asserts:
//
//   * its send happens with the reader PARKED IN HISTORY and the unread marker
//     on screen — a scenario built to make the marker collapse a suspect. This
//     report has no marker and no parking: the reader is at the tail and sends.
//     The tail write is reached through `tailFollowWhenSettled` in both, but a
//     spec that only ever exercises the parked entry cannot say the plain one
//     rests correctly;
//   * it asserts the ROW's box against the PANE's box (`overflowBelowPx`) and
//     only LOGS `distanceFromBottomPx`. The row-clipping face and the
//     rest-position face are not the same claim: a row can sit entirely inside
//     the pane while the pane is still short of its tail by less than one row.
//     This report is about the pane's rest position, so that is the assertion.
//
// 🔴 That second bullet is MEASURED, not reasoned. On the mutant bench below —
// the pre-cure code, this gesture — the numbers separate exactly as the bullet
// predicts: `overflowBelow = -0.172` (webkit) / `-0.422` (chromium), i.e. the
// row sits FULLY INSIDE the pane and 2031's assertion is GREEN, while
// `distanceFromBottom` reads 7 and 6 and the pane really is short. So the 2031
// spec, re-run on the untouched tree, would have reported this report's gesture
// as fine. The distance assertion is the one that catches it, and that is the
// whole reason this file exists.
//
// ## What this measured  (2026-09-10, on e7677913b)
//
// CURED TREE, `--repeat-each 3`, and byte-identical across all three repeats of
// every case — 12/12 green:
//
//   webkit-iphone-15  #1738 iphone          distance 0   overflowBelow -6.813
//   webkit-iphone-15  #2031 iphone          distance 0   overflowBelow -7.438
//   chromium          #1738 desktop-player  distance 0   overflowBelow -6.422
//   chromium          #2031 desktop         distance 0   overflowBelow -6.641
//
// MUTANT BENCH, because a spec born green has not been shown to be able to
// fail. `scrollToTail`'s top-up (the two lines `fffcc344c` added) was removed,
// restoring the pre-cure shape, and all four entries went RED:
//
//   webkit-iphone-15  #1738 iphone          distance 7   overflowBelow -0.172
//   webkit-iphone-15  #2031 iphone          distance 7   overflowBelow +0.203
//   chromium          #1738 desktop-player  distance 6   overflowBelow -0.422
//   chromium          #2031 desktop         distance 7   overflowBelow +0.359
//
// The bench is verified to BE the pre-cure state rather than merely broken: the
// two 2031 rows reproduce the numbers its own header recorded over nine runs
// before any cure existed (+0.203 webkit, +0.359 chromium) to the third
// decimal. So a red here is the reported mechanism and not some other damage.
//
// ## The configuration the report was taken in
//
// vjt's screenshots have the docked radio player under the scrollback ("no
// breathing room between the last line and whatever chrome sits below — the
// docked player, or the compose box when no player is up"). `.audio-mini-player`
// is an in-flow flex sibling with no positioning trick, so it can only reach
// the tail write through `clientHeight`; the case is here because it is the
// REPORTED configuration, not because a mechanism is suspected in it.
//
// ## Platform split, and it is deliberate rather than uniform
//
// The no-player case runs on `webkit-iphone-15` — the platform the report came
// from, and the one where issue 2031 measured the pre-cure shortfall
// DETERMINISTICALLY (3/3, distanceFromBottom = 7).
//
// The player case runs on desktop chromium. Docking the bar is a rail gesture,
// and on mobile the rail lives inside the members drawer, whose overlay lock
// FREEZES the pane — so a mobile player case would have to open and close a
// drawer, and would be testing the drawer's freeze/restore (which is #1701's
// subject) rather than the rest position. Stated rather than quietly skipped:
// "iPhone WITH the player docked" is not covered by this file.
//
// NO THIRD-PARTY NETWORK (#682 posture): the stream is served from local bytes
// by `page.route`, scoped to the station's real URL so a change that stops
// requesting it still fails.

import type { Page } from "@playwright/test";
import { silentMp3 } from "../fixtures/bytes";
import {
  composeSend,
  loginAs,
  openRailMenu,
  rowClearance,
  scrollbackDistanceFromBottom,
  scrollbackLines,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Literals rather than an import from `src/lib/radioStations`, matching the
// #682 / #1701 posture: a table edit that drops or renames this station must
// fail HERE instead of being followed silently.
const STATION_ID = "groovesalad";
const STATION_STREAM = "https://ice.somafm.com/groovesalad-128-mp3";

// The band for "the pane is at its own tail".
//
// 🔴 NOT `SCROLL_BOTTOM_THRESHOLD_PX`, which is 50 and is the tolerance under
// accusation: the whole reported defect (7px of unscrolled `padding-bottom`)
// fits inside it, so an assertion written in those terms is green against the
// thing it is named after.
//
// 2px is a sub-pixel band and not a knife edge. `scrollHeight` and
// `clientHeight` are integer-rounded while `scrollTop` is fractional, so a
// correct rest lands in [0, 1). Issue 2031 measured the two states seven pixels
// apart on both engines (correct 0, defective 7), so nothing can round across
// this line — only a shortfall can cross it.
const TAIL_RESIDUAL_TOLERANCE_PX = 2;

// Mirror of issue 2031's own tolerance for the row-vs-pane reading, and its
// reason carries over verbatim: the clipped state overflows the pane's bottom
// edge by +0.203px (webkit) / +0.359px (chromium), so a defensive 1px slack
// would swallow the defect whole.
const SUBPIXEL_TOLERANCE_PX = 0;

// Must outlast every #608 deferred writer before the terminal geometry is
// read: SETTLE_MAX_FRAMES (30) ≈ 0.5s, SCROLL_SETTLE_DEBOUNCE_MS = 500,
// PRESENCE_CURSOR_SETTLE_MS = 500. Same window issue 2031 and issue 625 sample
// over, for the same reason.
const SETTLE_WINDOW_MS = 2500;

// Bring the pane to the state the report is taken in: at the TRUE tail, with no
// unread marker, following for an honest reason.
//
// The pin is the RAW setter and not the app's own write, deliberately: the
// browser clamps `scrollTop = scrollHeight` to the real maximum INCLUDING the
// scroller's bottom padding, so the precondition is established by something
// other than the code under test. It also cannot mask a defect in what follows
// — the measured send happens after it, and a write that stops short lands
// short from wherever it started.
async function parkAtTrueTail(page: Page, tag: string): Promise<void> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

  // A send of our own first. It collapses whatever unread marker the seeded
  // buffer opened with (so the measured send below cannot be routed to a
  // marker-activation instead of tail-follow) and it arms the follow intent
  // through the app's own edge rather than leaving the mount default
  // undisturbed.
  await composeSend(page, `i1738 ${tag} warmup ${Date.now()}`);
  await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0, { timeout: 10_000 });

  await page.getByTestId("scrollback").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  // Let `onScroll` observe the pin — without it the pane never learns it is at
  // the tail and the state the report describes cannot exist.
  await page.waitForTimeout(300);
  await expect
    .poll(() => scrollbackDistanceFromBottom(page), { timeout: 5_000 })
    .toBeLessThanOrEqual(TAIL_RESIDUAL_TOLERANCE_PX);
}

// The body of both cases. One function because they differ only in the chrome
// below the pane, and a copy would let the two drift into asserting different
// things — which is the one comparison the pair exists to make.
async function sendAtTailAndAssertRestedAtTail(page: Page, tag: string): Promise<void> {
  await parkAtTrueTail(page, tag);

  const body = `i1738 ${tag} ${Date.now()}`;
  await composeSend(page, body);

  const sentLine = scrollbackLines(page).filter({ hasText: body });
  await expect(sentLine).toHaveCount(1, { timeout: 10_000 });

  // Let every deferred writer land before the terminal geometry is read.
  await page.waitForTimeout(SETTLE_WINDOW_MS);

  const clearance = await rowClearance(sentLine);
  console.log(`[#1738 ${tag}] clearance=${JSON.stringify(clearance)}`);

  // ── the reported tell: the pane rests where hand-scrolling would take it ──
  expect(
    clearance.distanceFromBottomPx,
    `the pane rests short of its own tail after a send, so it can still be ` +
      `hand-scrolled further down. distanceFromBottom=` +
      `${clearance.distanceFromBottomPx.toFixed(3)}px, ` +
      `overflowBelow=${clearance.overflowBelowPx.toFixed(3)}px. ` +
      `A residual near the scroller's 8px bottom padding is issue 2031's ` +
      `mechanism (the tail write not consuming it); a materially larger one is ` +
      `something else and the number is the lead.`,
  ).toBeLessThanOrEqual(TAIL_RESIDUAL_TOLERANCE_PX);

  // ── and the sent row is not clipped by the pane that holds it ──
  // The row-vs-pane face of the same rest. Kept alongside because the two can
  // separate: a pane one pixel short clips nothing, and a pane at its tail can
  // still hold a row past its edge if the write landed on the wrong element.
  expect(
    clearance.overflowBelowPx,
    `the sent row is clipped at the pane's bottom edge. ` +
      `overflowBelow=${clearance.overflowBelowPx.toFixed(3)}px, ` +
      `distanceFromBottom=${clearance.distanceFromBottomPx.toFixed(3)}px, ` +
      `hiddenBehindCompose=${clearance.hiddenBehindComposePx?.toFixed(3) ?? "n/a"}px.`,
  ).toBeLessThanOrEqual(SUBPIXEL_TOLERANCE_PX);
}

test.describe("issue 1738 — a send while already at the tail (iPhone, no player)", () => {
  // No `test.use({ viewport })`: the `webkit-iphone-15` project's device
  // descriptor owns the viewport, and overriding it would throw away the
  // fidelity that makes this the reported platform's case.
  test("@webkit the pane rests at its own tail, not one padding short", async ({ page }) => {
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await sendAtTailAndAssertRestedAtTail(page, "iphone");
  });
});

test.describe("issue 1738 — a send while already at the tail (desktop, player docked)", () => {
  // Tiny viewport so the seeded buffer overflows and the geometry is real —
  // the same 800×300 issue 580 / 625 / 2031 use.
  test.use({ viewport: { width: 800, height: 300 } });
  test.setTimeout(90_000);

  test("the docked player does not leave the pane short of its tail", async ({ page }) => {
    test.slow();
    await page.route("https://ice.somafm.com/**", async (route) => {
      await route.fulfill({ status: 200, contentType: "audio/mpeg", body: silentMp3(8) });
    });
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    // Dock the bar, then CLOSE the picker. The picker holds a
    // `createOverlayLock` refcount (#1701), and overlay-freeze outranks
    // tail-follow — a send underneath it would measure the freeze, not the rest
    // position.
    await openRailMenu(page);
    await page.getByTestId("rail-action-radio").click();
    const picker = page.getByTestId("rail-radio-picker");
    await expect(picker).toBeVisible();
    await page.getByTestId(`rail-radio-station-${STATION_ID}`).click();
    await expect(page.getByTestId("audio-mini-player-el")).toHaveJSProperty("src", STATION_STREAM);
    await expect(page.getByTestId("audio-mini-player")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("rail-radio-picker-close").click();
    await expect(picker).toBeHidden();

    // VACUITY GUARD. The case is "the reported chrome is under the pane"; if the
    // bar took no space out of the scroller, everything below is a re-run of the
    // no-player case wearing its name.
    const shrink = await page.getByTestId("scrollback").evaluate(() => {
      const bar = document.querySelector(".audio-mini-player") as HTMLElement | null;
      if (!bar) throw new Error("the docked player is not mounted");
      return bar.getBoundingClientRect().height;
    });
    expect(shrink, "the docked player occupies no height").toBeGreaterThan(20);

    await sendAtTailAndAssertRestedAtTail(page, "desktop-player");
  });
});
