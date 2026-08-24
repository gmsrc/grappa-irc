// #1701 — chrome mounting UNDER a covering overlay must not leave a tail reader
// short of the tail once the overlay goes.
//
// The container twin of issue1121-overlay-close-tail-reader, which drives the
// same site on the CONTENT axis: there the box was steady and lines grew
// underneath, here the content is steady and the BOX shortens. Both are the one
// sentence `applyOverlayRestore` is now written around — the freeze holds a
// single number, and a scrollTop names a position only relative to the viewport
// it was read through.
//
// The gesture is the reported one, and every step of it is load-bearing:
//
//   * the rail's station picker holds a `createOverlayLock` refcount, so the
//     pane is FROZEN from the moment it opens;
//   * picking a station deliberately does NOT close it (`RailRadio`: a control
//     the operator re-flips in place is not a launcher), so the docked bar
//     mounts WHILE the freeze is up;
//   * the bar takes ~47px out of `.scrollback`, and #778's ResizeObserver
//     re-pin — which exists for exactly this class — is outranked by
//     overlay-freeze and dropped. Correctly: a mid-list reader under an overlay
//     must not be yanked;
//   * no overlay edge fires again until the picker is closed, and that close
//     edge is where the debt is owed.
//
// WHY THE ASSERTIONS ARE IN RAW PIXELS AND NOT IN THE TAIL THRESHOLD.
// `SCROLL_BOTTOM_THRESHOLD_PX` is 50 and the bar is about 47, so "is the reader
// within the tail band" answers YES on the BROKEN build. A spec written against
// the threshold here would be green against the defect it is named after. The
// distance is therefore compared against the measured shrink and against a
// sub-pixel epsilon, and the shrink is measured rather than assumed so a bar
// that changes height does not quietly turn this vacuous.
//
// NO THIRD-PARTY NETWORK, the #682 posture: the stream and the logos are served
// from local bytes by `page.route`, scoped to the station's real URL so a change
// that stops requesting it still fails.
//
// Desktop project (untagged → chromium), like both siblings on this site. The
// freeze is not form-factor gated — `RailRadio` calls `createOverlayLock`
// unconditionally — so the defect reproduces identically here, and desktop
// Chrome is the platform whose scroll physics these specs are written against
// (feedback: webkit is not iOS). The mobile-only half of #1701, where the bar
// should be docked, is a separate layout ruling and is not this spec's subject.

import { silentMp3 } from "../fixtures/bytes";
import {
  composeSend,
  loginAs,
  openRailMenu,
  scrollbackDistanceFromBottom,
  scrollbackLines,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Literals rather than an import from `src/lib/radioStations`, matching the #682
// spec: a table edit that drops or renames this station must fail HERE instead
// of being followed silently.
const STATION_ID = "groovesalad";
const STATION_STREAM = "https://ice.somafm.com/groovesalad-128-mp3";

// Sub-pixel band. "At the tail" in a real browser is a fractional zero, not an
// integral one, and this is deliberately far below the 47px the defect leaves.
const TAIL_EPSILON_PX = 2;

test.setTimeout(90_000);

test("#1701 — tuning a station under the open picker leaves the reader ON the tail", async ({
  page,
}) => {
  test.slow();
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

  await page.route("https://ice.somafm.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "audio/mpeg", body: silentMp3(8) });
  });
  await page.route("https://api.somafm.com/logos/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(0) });
  });

  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // A line of our own at the tail. An own send also arms the follow intent
  // through its own edge, so the reader is following for the honest reason
  // rather than because the mount default has not been disturbed yet.
  await composeSend(page, "arr1701-last-line");
  await expect(page.getByText("arr1701-last-line")).toBeVisible({ timeout: 15_000 });

  const sc = page.getByTestId("scrollback");

  // Pin AND let onScroll measure it — the measurement is the precondition, the
  // same one #1121's helper spells out: without it the pane never learns it is
  // at the tail and the state the bug needs cannot exist.
  const before = await sc.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return { clientHeight: el.clientHeight };
  });
  await page.waitForTimeout(300);
  await expect
    .poll(() => scrollbackDistanceFromBottom(page), { timeout: 5_000 })
    .toBeLessThanOrEqual(TAIL_EPSILON_PX);

  // Tune a station. The rail drawer's own overlay opens first and the picker
  // inherits the refcount from it; either way the snapshot is captured while the
  // reader is at the tail and BEFORE the bar exists.
  await openRailMenu(page);
  await page.getByTestId("rail-action-radio").click();
  const picker = page.getByTestId("rail-radio-picker");
  await expect(picker).toBeVisible();
  await page.getByTestId(`rail-radio-station-${STATION_ID}`).click();

  const audio = page.getByTestId("audio-mini-player-el");
  await expect(audio).toHaveJSProperty("src", STATION_STREAM);
  await expect(page.getByTestId("audio-mini-player")).toBeVisible({ timeout: 15_000 });

  // Precondition, asserted and not assumed: picking must leave the picker UP.
  // The day that changes, the freeze lifts on the same tick as the bar mounts
  // and this spec silently stops reproducing anything — so it should go red
  // here, at the premise, rather than pass for the wrong reason below.
  await expect(picker).toBeVisible();

  const during = await sc.evaluate((el) => ({
    clientHeight: el.clientHeight,
    distanceToBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
  }));

  // The bar really took its space out of the scroll container — measured, not
  // assumed, because every assertion below is vacuous without it.
  const shrink = before.clientHeight - during.clientHeight;
  expect(shrink).toBeGreaterThan(20);

  // And the reader was left behind by exactly that much, because the freeze ate
  // the re-pin. This is the defect observed live, and it is TRUE ON BOTH BUILDS:
  // the fix lands on the close edge, deliberately, rather than teaching a
  // container change to outrank the freeze (which is the signal #219 exists to
  // suppress). Pinned so a future widening of the freeze is visible here.
  expect(during.distanceToBottom).toBeGreaterThan(shrink - TAIL_EPSILON_PX);

  await page.getByTestId("rail-radio-picker-close").click();
  await expect(picker).toBeHidden();

  // OBSERVABLE 1 — the close edge restores the INTENT, not the stale proxy.
  // Pre-fix this sits at `shrink` and stays there for as long as the reader
  // keeps reading: nothing else will ever move it.
  await expect
    .poll(() => scrollbackDistanceFromBottom(page), { timeout: 5_000 })
    .toBeLessThanOrEqual(TAIL_EPSILON_PX);

  // OBSERVABLE 2 — the same fact in the reporter's own words: "the last lines
  // are left under it". The LAST row rather than our marker, so a line arriving
  // from elsewhere on this shared channel moves the target instead of breaking
  // the claim.
  await expect(scrollbackLines(page).last()).toBeInViewport({ ratio: 1 });
});
