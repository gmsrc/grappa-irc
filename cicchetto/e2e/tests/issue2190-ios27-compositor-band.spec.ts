// issue 2190 — the iOS/iPadOS 27 compositor band, and the 16px of clearance
// gated under it.
//
// WHAT THIS SPEC CAN AND CANNOT SEE. It cannot see the band: that is painted
// by the iOS 27 compositor ABOVE the web view, on a device nobody on this
// side owns, and no engine Playwright drives reproduces it. What it CAN see
// — and what jsdom structurally cannot, since it has no layout engine — is
// the thing the cure actually has to deliver: that on an iOS 27 installed
// PWA the first scrollback row sits 16 real pixels lower than it otherwise
// would, and that on everything else NOTHING moves.
//
// SHAPE: one test, two browser contexts, A/B. The two differ in ONE byte
// range of one string — `27_0`/`Version/27.0` against `26_0`/`Version/26.0`
// in the user agent — so every other input to the layout is held fixed by
// construction. That is what makes the "no platform without the gate pays"
// half (ruling point 5) a MEASUREMENT here rather than an assertion: the 26
// context takes the identical code path with the class absent, so its boxes
// ARE the pre-change boxes, and they are compared pixel for pixel.
//
// `@webkit` alone, deliberately, and it puts this spec in the iOS-bound
// group the config header describes: the behaviour under test is gated on
// `isIos()`, so on `chromium-pixel-touch` the class could never appear and
// both halves of the A/B would go green for the wrong reason.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: a
// subject-shape-agnostic platform/CSS contract — registered vjt suffices.

import type { Browser, Page } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0] as string;

// The class the boot probe writes on <html>. Spelled once here rather than
// imported: `e2e/` compiles against its own tsconfig and does not reach into
// `src/`, and the unit suite already pins the production spelling against
// the stylesheet (`src/__tests__/ios27Band.test.ts`).
const BAND_CLASS = "is-ios27-band";

// The reported clearance. Not measured by us — see the stylesheet comment.
const CLEARANCE_PX = 16;

// The two user agents. iPhone Safari shape, differing ONLY in the major, so
// the A/B has exactly one variable. Both keep `Version/`, unlike the real
// home-screen UA which drops it — that shape is covered by the unit table
// (row 9); what this file needs is a minimal pair.
const uaForMajor = (major: number) =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS ${major}_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${major}.0 Mobile/15E148 Safari/604.1`;

type Booted = { page: Page; close: () => Promise<void> };

// A logged-in cic on a channel window, running as an INSTALLED PWA at the
// given iOS major. `navigator.standalone` is the standalone half of the gate
// — the same seam `issue259-install-hint.spec.ts` rides, and the only one a
// browser context can supply (Playwright emulates no `display-mode`).
async function bootInstalledPwa(browser: Browser, major: number): Promise<Booted> {
  const ctx = await browser.newContext({ userAgent: uaForMajor(major) });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
  });
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  return { page, close: () => ctx.close() };
}

type Geometry = {
  /** Computed `padding-top` of the scroll container, in px. */
  paddingTop: number;
  /** Computed `scroll-padding-top` — `auto` is the ungated initial value. */
  scrollPaddingTop: string;
  /** Distance from the scroll container's top edge to its first row, at scrollTop 0. */
  firstRowOffset: number;
  /** Boxes that must not move at all. */
  boxes: Record<string, string>;
};

async function measure(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const scrollback = document.querySelector(".scrollback");
    if (scrollback === null) throw new Error("no .scrollback — the shell did not reach a channel");
    // Park at the very top: the clearance is the FIRST thing in the scroll
    // content, so a list resting at the bottom would hide the whole effect
    // and the measurement would be a vacuous zero on both sides.
    scrollback.scrollTop = 0;
    const style = getComputedStyle(scrollback);
    const first = scrollback.firstElementChild;
    if (first === null) throw new Error("no scrollback rows — nothing to measure against");
    const box = (selector: string): string => {
      const el = document.querySelector(selector);
      if (el === null) return "absent";
      const r = el.getBoundingClientRect();
      return `${r.x},${r.y},${r.width},${r.height}`;
    };
    return {
      paddingTop: Number.parseFloat(style.paddingTop),
      scrollPaddingTop: style.scrollPaddingTop,
      firstRowOffset: first.getBoundingClientRect().top - scrollback.getBoundingClientRect().top,
      boxes: {
        shell: box(".shell"),
        shellMain: box(".shell-main"),
        topicBar: box(".topic-bar"),
        scrollbackPane: box(".scrollback-pane"),
        scrollback: box(".scrollback"),
        compose: box(".compose-box"),
      },
    };
  });
}

test("@webkit issue2190 — iOS 27 PWA clears 16px, iOS 26 renders identically", async ({
  browser,
}) => {
  const on = await bootInstalledPwa(browser, 27);
  const off = await bootInstalledPwa(browser, 26);
  try {
    // Both are iOS installed PWAs — `is-ios` proves the control is not
    // passing by falling off the platform entirely.
    await expect(on.page.locator("html")).toHaveClass(/\bis-ios\b/);
    await expect(off.page.locator("html")).toHaveClass(/\bis-ios\b/);
    await expect(on.page.locator("html")).toHaveClass(new RegExp(`\\b${BAND_CLASS}\\b`));
    await expect(off.page.locator("html")).not.toHaveClass(new RegExp(`\\b${BAND_CLASS}\\b`));

    const withBand = await measure(on.page);
    const without = await measure(off.page);

    // THE VISIBLE OUTCOME: the first row of scrollback is 16px further from
    // the top edge, which is the pixel range the band eats.
    expect(withBand.firstRowOffset - without.firstRowOffset).toBeCloseTo(CLEARANCE_PX, 1);
    expect(withBand.paddingTop - without.paddingTop).toBeCloseTo(CLEARANCE_PX, 1);

    // The anchoring half: `scroll-padding-top` moves the landing line for
    // jump-to-message down with the padding, and is untouched off the gate.
    expect(withBand.scrollPaddingTop).toBe(`${CLEARANCE_PX}px`);
    expect(without.scrollPaddingTop).toBe("auto");

    // Ruling point 5, measured: nothing else moves by so much as a pixel.
    // The shell, the chrome and the pane keep their exact boxes — only the
    // scroll CONTENT is inset, which is also the honest statement of what
    // this placement does and does not cure.
    expect(withBand.boxes).toEqual(without.boxes);
  } finally {
    await on.close();
    await off.close();
  }
});
