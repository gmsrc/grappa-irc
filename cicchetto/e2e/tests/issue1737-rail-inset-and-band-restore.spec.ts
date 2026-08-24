// #1737 — two defects on the rail's now-playing band, and both need a BROWSER.
//
//   (a) the band sat flush against the rail edges while the `actions` launcher
//       below it was inset, so the two surfaces did not line up. vjt ruled the
//       cure is to move the horizontal inset onto the rail CONTAINER, with the
//       children at zero, rather than to give the band a matching value by
//       hand — one owner, one number, no drift between the rows.
//   (b) the band was inert except for its ⏹: tapping what is playing did not
//       bring back a transport the operator had hidden (#1697).
//
// WHY E2E AND NOT VITEST. (a) is RENDERED GEOMETRY. jsdom computes no layout —
// every `getBoundingClientRect()` there is zero — so a unit test can only
// assert that some declaration exists, which is a mirror of the stylesheet and
// would have passed just as happily before the fix. The whole defect is "these
// two boxes have different edges", and only a real engine has edges.
// (b)'s STATE half is pinned in `src/__tests__/RailRadio.test.tsx`; what is
// left for here is its GEOMETRIC half — that the restore control does not
// cover the ⏹, which is a hit-test and therefore also engine-only.
//
// THE ASSERTION IS A RELATION, NOT A NUMBER. It compares the band's edges with
// the launcher's rather than checking either against `0.5rem`. A pixel literal
// would re-encode the very value the fix just made single-source, and would go
// red on a root-font-size change that broke nothing. Measured on the defect:
// the band's border box started at the rail's inner edge and the launcher's
// started 0.5rem in, so the equality below is exactly what did not hold.
//
// FORM FACTOR, stated rather than implied: this runs on desktop chromium. The
// rule it proves lives on `.shell-members`, which both Shell branches mount
// and both form factors style from — the mobile drawer adds only `padding-top`
// / `padding-bottom` for the safe area, separate longhands from the
// `padding-inline` this asserts, so there is no shorthand for one to clobber
// the other with. The phone is not separately covered here.
//
// NO THIRD-PARTY NETWORK, for the reason the #682 spec spells out: the stream
// and the logos are served from local bytes, so a somafm.com outage cannot
// turn this red.

import type { Page } from "@playwright/test";
import { silentMp3 } from "../fixtures/bytes";
import { loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Literals, not an import from `src/lib/radioStations`, so a table edit that
// drops or renames this station fails HERE instead of being followed silently.
const STATION_ID = "groovesalad";
const STATION_STREAM = "https://ice.somafm.com/groovesalad-128-mp3";

// Sub-pixel slack: the engine lays these boxes out in device pixels, so two
// edges that agree can still differ in the last fraction. Written as an
// explicit `Math.abs(…) < EPSILON` below rather than with `toBeCloseTo`,
// whose second argument is a DIGIT COUNT and not a tolerance — passing 0.5
// there would silently mean "round to half a decimal digit".
const EPSILON = 0.5;

test.setTimeout(90_000);

/** Tune the spec's station from the rail picker and leave the picker shut. */
const tuneStation = async (page: Page): Promise<void> => {
  await openRailMenu(page);
  await page.getByTestId("rail-action-radio").click();
  await expect(page.getByTestId("rail-radio-picker")).toBeVisible();
  await page.getByTestId(`rail-radio-station-${STATION_ID}`).click();
  await expect(page.getByTestId("audio-mini-player-el")).toHaveJSProperty("src", STATION_STREAM);
  // Picking deliberately does NOT close the picker (#682), and it overlays the
  // whole rail — so the band underneath is unreachable until it is dismissed.
  await page.getByTestId("rail-radio-picker-close").click();
  await expect(page.getByTestId("rail-radio-picker")).toBeHidden();
  await expect(page.getByTestId("rail-radio-now")).toBeVisible();
};

const routeLocalAudio = async (page: Page): Promise<void> => {
  await page.route("https://ice.somafm.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "audio/mpeg", body: silentMp3(8) });
  });
  await page.route("https://api.somafm.com/logos/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(0) });
  });
};

test("#1737 — the rail's surfaces share one horizontal inset, owned by the rail", async ({
  page,
}) => {
  await routeLocalAudio(page);
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await tuneStation(page);

  const rail = await page.locator(".shell-members").boundingBox();
  const band = await page.getByTestId("rail-radio-now").boundingBox();
  const launcher = await page.getByTestId("rail-actions-launcher").boundingBox();
  if (rail === null || band === null || launcher === null) {
    throw new Error("rail, band and launcher must all be laid out for this to mean anything");
  }

  // THE DEFECT: a full-bleed band above an inset button. Both edges, because
  // an inset applied on one side only would satisfy half of this and still
  // look wrong.
  expect(Math.abs(band.x - launcher.x)).toBeLessThan(EPSILON);
  expect(Math.abs(band.x + band.width - (launcher.x + launcher.width))).toBeLessThan(EPSILON);

  // …and they line up INSET, not merely with each other: the pair could agree
  // by both bleeding to the edges, which is the state this issue rejects.
  expect(band.x).toBeGreaterThan(rail.x);
  expect(band.x + band.width).toBeLessThan(rail.x + rail.width);

  // Symmetric, so the inset reads as one value and not as two that happen to
  // both be non-zero.
  const leftGap = band.x - rail.x;
  const rightGap = rail.x + rail.width - (band.x + band.width);
  // The rail's own `border-left` lives inside its bounding box, so the two
  // gaps differ by that 1px by construction — the tolerance names it rather
  // than pretending the box is symmetric.
  expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1 + EPSILON);
});

test("#1737 — tapping the band brings back a hidden transport, and ⏹ still stops", async ({
  page,
}) => {
  await routeLocalAudio(page);
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await tuneStation(page);

  const dockedPlayer = page.getByTestId("audio-mini-player");
  await expect(dockedPlayer).toBeVisible();

  // Hide the transport the way the operator does — the control #1697 added.
  await page.getByTestId("audio-mini-player-hide").click();
  await expect(dockedPlayer).toBeHidden();

  // (b) the band is the obvious door back, and this is a REAL tap: it lands
  // wherever the restore control actually is, so a control that renders behind
  // the band or collapses to zero width fails here.
  await page.getByTestId("rail-radio-now-restore").click();
  await expect(dockedPlayer).toBeVisible();

  // The ⏹ keeps its own tap target — the issue's explicit constraint, and the
  // half a unit test cannot reach. `closeAudio` resets `playerHidden` itself,
  // so "stopped" and "restored then stopped" are the same STATE; what is
  // provable is that the click lands on stop at all, i.e. that the restore
  // control neither covers the ⏹ nor swallows its click.
  await page.getByTestId("audio-mini-player-hide").click();
  await expect(dockedPlayer).toBeHidden();
  await page.getByTestId("rail-radio-stop").click();
  // Both surfaces go: the band because nothing is tuned any more, the docked
  // chrome because there is no source. NOT `audio-mini-player-el` — that
  // element is mounted UNCONDITIONALLY (AudioMiniPlayer's header says why: a
  // <Show> around it would race the ref assignment), so asserting on its
  // absence would assert the opposite of the design.
  await expect(page.getByTestId("rail-radio-now")).toBeHidden();
  await expect(dockedPlayer).toBeHidden();
});
