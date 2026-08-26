// #1802 — the rail's horizontal inset, measured on every surface at once.
//
// #1737 moved the inset onto `.shell-members` and left ONE child out:
// `.members-pane` cancelled it with a negative `margin-inline` on its own rule
// and its rows re-declared 1rem of their own. So the radio band and the
// actions launcher sat at half a rem while the nick list above them sat at a
// full one, and the eye read the difference as a bug in the band. The query
// rail's heading — which the issue calls the members heading's twin, and which
// nobody had measured — was WORSE than either: `.rail-query-context` is an
// ordinary flow child INSIDE the rail's padding, so its heading's own 1rem
// stacked on the container's 0.5rem and the label rendered at one and a half.
//
// WHY E2E AND NOT VITEST, for the same reason `issue1737-rail-inset-and-band-
// restore` gives: this is RENDERED GEOMETRY, jsdom computes none of it, and a
// unit assertion could only restate the stylesheet. The SOURCE half — that the
// inset is DECLARED by the container and not merely rendered in the right
// place — is what `src/__tests__/railInset.test.ts` covers, because no
// measurement can see where a value was written. The two halves are disjoint
// on purpose: a child re-declaring the same 0.5rem by hand passes this file
// forever and fails that one.
//
// THE ORACLE READS THE TOKEN, IT DOES NOT SPELL IT. The expected gap comes
// from the container's own resolved `padding-left`, which IS `--rail-inset` in
// pixels as the engine computed it — so this stays green across a root
// font-size change and red the moment a surface stops agreeing with the rail.
// It could degenerate: if the container's padding vanished, the expected gap
// would become 0 and a fully full-bleed rail would satisfy the equality. The
// `> 0` assertion below is what forbids that, and it is not decoration.
//
// SURFACE vs INK, stated because the file mixes them. What the operator sees
// begin at an edge is the BORDER BOX for a child that paints one (the band's
// background and border-top, the actions drawer's border-top) and the GLYPHS
// for a child that paints nothing (a nick row is transparent, unbordered, and
// its hover is an underline — #1737). Measuring a nick row's border box would
// measure the full-bleed scroller it lives in and see nothing at all, which is
// precisely how this defect survived a year.
//
// FORM FACTOR: desktop chromium. `.resize-handle-right` is desktop-only by
// construction (Shell.tsx mounts it in the desktop branch alone), so its
// assertion has no phone counterpart to be missing. The inset rules themselves
// live on `.shell-members`, which both branches mount and neither overrides
// horizontally — the mobile block adds block-axis safe-area longhands only.
//
// NO THIRD-PARTY NETWORK: the radio stream is fulfilled from local bytes and
// the station logos are vendored, the same posture as the #682 and #1737
// specs, so a somafm.com outage cannot turn this red.

import type { Page } from "@playwright/test";
import { silentMp3 } from "../fixtures/bytes";
import {
  composeSend,
  loginAs,
  openRailMenu,
  selectChannel,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Literals rather than an import from `src/lib/radioStations`, so a table edit
// that drops or renames this station fails HERE instead of following silently
// — the rule `issue1737-rail-inset-and-band-restore` set for the same pair.
const STATION_ID = "groovesalad";
const STATION_STREAM = "https://ice.somafm.com/groovesalad-128-mp3";

// Unique suffix so a retry or a sibling spec never collides on a nick already
// in use upstream (the convention in issue606 / issue984).
const RUN_ID = crypto.randomUUID().slice(0, 8);
const PEER = `Q1802${RUN_ID}`;

// Sub-pixel slack. Written as an explicit `Math.abs(…) <= EPSILON` rather than
// `toBeCloseTo`, whose second argument is a DIGIT COUNT and not a tolerance.
// The defect it must not swallow is 7px at the default font size; this is half
// a device pixel, three orders below it.
const EPSILON = 0.5;

test.setTimeout(120_000);

const routeLocalAudio = async (page: Page): Promise<void> => {
  await page.route("https://ice.somafm.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "audio/mpeg", body: silentMp3(8) });
  });
};

/** Tune the spec's station from the rail picker and leave the picker shut. */
const tuneStation = async (page: Page): Promise<void> => {
  await openRailMenu(page);
  await page.getByTestId("rail-action-radio").click();
  await expect(page.getByTestId("rail-radio-picker")).toBeVisible();
  await page.getByTestId(`rail-radio-station-${STATION_ID}`).click();
  await expect(page.getByTestId("audio-mini-player-el")).toHaveJSProperty("src", STATION_STREAM);
  // Picking deliberately does NOT close the picker (#682), and it overlays the
  // whole rail — the band underneath is unmeasurable until it is dismissed.
  await page.getByTestId("rail-radio-picker-close").click();
  await expect(page.getByTestId("rail-radio-picker")).toBeHidden();
  await expect(page.getByTestId("rail-radio-now")).toBeVisible();
};

type RailFrame = {
  /** Inner edge of the aside: its border box left plus its own border. */
  innerLeft: number;
  right: number;
  /** `--rail-inset` in pixels, as the engine resolved it on the container. */
  inset: number;
};

const readRailFrame = (page: Page): Promise<RailFrame> =>
  page.evaluate(() => {
    const rail = document.querySelector(".shell-members");
    if (rail === null) throw new Error("the rail must be mounted for any of this to mean anything");
    const box = rail.getBoundingClientRect();
    const style = getComputedStyle(rail);
    return {
      innerLeft: box.x + Number.parseFloat(style.borderLeftWidth),
      right: box.x + box.width,
      inset: Number.parseFloat(style.paddingLeft),
    };
  });

/** The left edge of a child's painted BORDER BOX. */
const surfaceLeft = (page: Page, selector: string): Promise<number> =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`no element for ${sel}`);
    return el.getBoundingClientRect().x;
  }, selector);

/** The left edge of a child's GLYPHS, for a row that paints no surface. */
const inkLeft = (page: Page, selector: string): Promise<number> =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`no element for ${sel}`);
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()];
    if (rects.length === 0) throw new Error(`${sel} laid out no text — nothing to measure`);
    return Math.min(...rects.map((r) => r.x));
  }, selector);

test("#1802 — every rail surface starts at the container's one inset", async ({ page }) => {
  await routeLocalAudio(page);
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await tuneStation(page);

  // The members list must actually have a row, or the assertion that used to
  // fail would simply be absent — the shape `issue500`'s spec warns about.
  await expect(page.locator(".members-pane li").first()).toBeVisible();

  const rail = await readRailFrame(page);
  // Degenerate-oracle guard: the expected gap is READ from the container, so a
  // rail that stopped insetting anything at all would make the equality below
  // trivially true. It must be a real inset.
  expect(rail.inset, "the rail must still carry a non-zero inset of its own").toBeGreaterThan(0);
  const expected = rail.innerLeft + rail.inset;

  const measured = {
    "radio band (surface)": await surfaceLeft(page, ".rail-radio-now"),
    "actions drawer (surface)": await surfaceLeft(page, ".rail-actions"),
    "actions launcher (surface)": await surfaceLeft(page, ".rail-actions-launcher"),
    "members heading (ink)": await inkLeft(page, ".members-pane h3"),
    "first nick row (ink)": await inkLeft(page, ".members-pane li"),
  };

  // ONE measurement, not two. Pre-fix the first three read `expected` and the
  // last two read one whole inset further in — the reported 2:1.
  for (const [what, left] of Object.entries(measured)) {
    expect(
      Math.abs(left - expected),
      `${what} at ${left}, rail inset lands at ${expected}`,
    ).toBeLessThanOrEqual(EPSILON);
  }

  // Constraint (2): the scroller still spans the rail edge to edge, so its
  // scrollbar rides the rail's own border rather than floating half a rem off
  // it. The scrollbar has no box of its own to query; the scroll container's
  // border box is where it runs, which is what this asserts.
  const pane = await page.locator(".members-pane").boundingBox();
  if (pane === null) throw new Error("the members pane must be laid out");
  expect(Math.abs(pane.x - rail.innerLeft), "pane left vs rail inner edge").toBeLessThanOrEqual(
    EPSILON,
  );
  expect(
    Math.abs(pane.x + pane.width - rail.right),
    "pane right (where the scrollbar runs) vs rail right",
  ).toBeLessThanOrEqual(EPSILON);

  // The companion the issue calls for, and a defect in its own right: the grip
  // rendered ENTIRELY outside the aside, over the centre pane, because #1737
  // cancelled a padding that an absolutely positioned box never saw. Its own
  // base rule requires it to sit fully inside the aside.
  const grip = await page.locator(".resize-handle-right").boundingBox();
  if (grip === null) throw new Error("the desktop resize grip must be laid out");
  expect(grip.x, "grip left must be inside the rail").toBeGreaterThanOrEqual(
    rail.innerLeft - EPSILON,
  );
  expect(grip.x + grip.width, "grip right must be inside the rail").toBeLessThanOrEqual(
    rail.right + EPSILON,
  );
});

test("#1802 — the query rail's heading lands on the same inset", async ({ page }) => {
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: PEER, gecos: "rail inset probe" });
  try {
    // Shared channel so the query is a real one and the rail context mounts.
    await peer.join(CHANNEL);
    await composeSend(page, `/q ${PEER}`);
    await waitForQueryWindowReady(page, NETWORK_SLUG, PEER);
    await expect(page.getByTestId("rail-query-context")).toBeVisible({ timeout: 5_000 });

    const rail = await readRailFrame(page);
    expect(rail.inset, "the rail must still carry a non-zero inset of its own").toBeGreaterThan(0);
    const expected = rail.innerLeft + rail.inset;

    // The worst of the three, and the one the issue mis-described as "the same
    // problem" as the members heading: this slot's parent is NOT full-bleed, so
    // its own horizontal padding stacked on the container's instead of
    // replacing it. Measured at one and a half insets before the fix.
    const heading = await inkLeft(page, ".rail-query-heading");
    expect(
      Math.abs(heading - expected),
      `query heading ink at ${heading}, rail inset lands at ${expected}`,
    ).toBeLessThanOrEqual(EPSILON);

    // The launcher below it is the fixed reference the heading has to agree
    // with — asserting only against `expected` would pass a build where BOTH
    // had drifted together off the container's number.
    const launcher = await surfaceLeft(page, ".rail-actions-launcher");
    expect(Math.abs(heading - launcher), "query heading vs actions launcher").toBeLessThanOrEqual(
      EPSILON,
    );
  } finally {
    await peer.disconnect("#1802 done");
  }
});
