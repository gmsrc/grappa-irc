// issue 2190 — the iOS/iPadOS 27 compositor band, and the 38px of clearance
// gated under it on `.shell`.
//
// WHAT THIS SPEC CAN AND CANNOT SEE. It cannot see the band: that is painted
// by the iOS 27 compositor ABOVE the web view, on a device nobody on this
// side owns, and no engine Playwright drives reproduces it. A green here is
// therefore NOT evidence that the veil is gone — only the phone can say that.
// What it CAN see, and what jsdom structurally cannot since it has no layout
// engine, is the thing the cure has to deliver mechanically: that on an iOS
// 27 installed PWA the whole shell — chrome included, which is the point of
// vjt's ruling on point 4 — sits 38 real pixels lower, that the clearance is
// ADDED to the safe-area inset rather than replacing it, and that on
// everything else NOTHING moves.
//
// 🔴 WHY THE INSET IS STUBBED, AND WHY THE SPEC IS WORTHLESS WITHOUT IT.
// Playwright synthesizes no safe-area inset on any engine — they resolve to
// 0, measured in issue913-rail-menu-safe-area.spec.ts. At a zero inset
// `calc(var(--safe-area-inset-top) + 38px)` and a bare `38px` compute the
// SAME number, so the headline regression this rule guards against — the
// gated declaration OVERRIDING `.shell`'s inset instead of adding to it, a
// net loss of 24px that pulls content under the Dynamic Island — is
// invisible at inset 0. Re-declaring `--safe-area-inset-top` at a non-zero
// length on a `:root:root` override is what makes the two cases different
// numbers, and it is the same seam #913 uses to prove its own wiring.
//
// SHAPE: two browser contexts, A/B. The two differ in ONE byte range of one
// string — `27_0`/`Version/27.0` against `26_0`/`Version/26.0` in the user
// agent — so every other input to the layout is held fixed by construction.
// That is what makes the "no platform without the gate pays" half (ruling
// point 5) a MEASUREMENT here rather than an assertion: the 26 context takes
// the identical code path with the class absent, so its boxes ARE the
// pre-change boxes.
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

// The measured clearance. 38 CSS px: the veil dies 100 px from the screen
// edge, the first 62 of which are the status bar and are ceded anyway.
const CLEARANCE_PX = 38;

// The stubbed inset. An arbitrary non-zero length — its only job is to be
// distinguishable from both 0 and from CLEARANCE_PX, so that "added" and
// "replaced" produce different numbers. 59 is the value #913's spec uses.
const STUB_INSET_PX = 59;

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

/**
 * Re-declare the safe-area top inset at a non-zero length. `:root:root` is
 * specificity 0,2,0 and beats the sheet's own `:root`, and every consumer
 * reads the token rather than `env()` (the #1751 invariant), so this moves
 * all of them at once — which is exactly why the invariant is worth having.
 */
async function stubTopInset(page: Page, px: number): Promise<void> {
  await page.addStyleTag({ content: `:root:root { --safe-area-inset-top: ${px}px; }` });
}

type Geometry = {
  /** Computed `padding-top` of the shell, in px — where the clearance lands. */
  shellPaddingTop: number;
  /** Viewport-absolute top of cic's own chrome. Ruling point 4 lives here. */
  topicBarTop: number;
  /** Viewport-absolute top of the first scrollback row. */
  firstRowTop: number;
  /** Boxes of surfaces OUTSIDE the shell's flow — these must not move. */
  outside: Record<string, string>;
};

async function measure(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const shell = document.querySelector(".shell");
    if (shell === null) throw new Error("no .shell — the app did not render");
    const scrollback = document.querySelector(".scrollback");
    if (scrollback === null) throw new Error("no .scrollback — the shell did not reach a channel");
    scrollback.scrollTop = 0;
    const first = scrollback.firstElementChild;
    if (first === null) throw new Error("no scrollback rows — nothing to measure against");
    const topicBar = document.querySelector(".topic-bar");
    if (topicBar === null) throw new Error("no .topic-bar — the chrome under test is absent");
    const box = (selector: string): string => {
      const el = document.querySelector(selector);
      if (el === null) return "absent";
      const r = el.getBoundingClientRect();
      return `${r.x},${r.y},${r.width},${r.height}`;
    };
    return {
      shellPaddingTop: Number.parseFloat(getComputedStyle(shell).paddingTop),
      topicBarTop: topicBar.getBoundingClientRect().top,
      firstRowTop: first.getBoundingClientRect().top,
      // The surfaces the cure deliberately does NOT reach: they are
      // `position: fixed` and anchor themselves to the inset, so they sit
      // outside `.shell`'s padding box and stay under the veil. Pinned as
      // unchanged so the known gap is a measured fact in this PR, not a
      // guess — and so the follow-up that fixes them has a baseline.
      outside: {
        errorBanners: box(".error-banners"),
      },
    };
  });
}

test("@webkit issue2190 — iOS 27 PWA shifts the whole shell 38px, iOS 26 renders identically", async ({
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

    // ── Part 1, at the engine's own inset (0): the clearance is spent, and
    // it is spent on the CHROME as well as the scrollback. That second half
    // is the whole of vjt's ruling on point 4 — the previous shipped cure
    // padded the scroll content and left the chrome where the veil lands.
    const withBand = await measure(on.page);
    const without = await measure(off.page);

    expect(withBand.shellPaddingTop - without.shellPaddingTop).toBeCloseTo(CLEARANCE_PX, 1);
    expect(withBand.topicBarTop - without.topicBarTop).toBeCloseTo(CLEARANCE_PX, 1);
    expect(withBand.firstRowTop - without.firstRowTop).toBeCloseTo(CLEARANCE_PX, 1);

    // The known gap, measured rather than asserted: the top-anchored fixed
    // overlays do NOT move, so they remain under the veil after this change.
    expect(withBand.outside).toEqual(without.outside);

    // ── Part 2, THE ONE THAT CATCHES THE REGRESSION. With a real inset in
    // play the two candidate rules stop agreeing: adding gives inset + 38,
    // replacing gives 38 flat, i.e. 21px LESS than the ungated control gets.
    // At the engine's native inset of 0 both read 38 and Part 1 passes
    // either way, which is why this half is not optional.
    await stubTopInset(on.page, STUB_INSET_PX);
    await stubTopInset(off.page, STUB_INSET_PX);
    const withBandStubbed = await measure(on.page);
    const withoutStubbed = await measure(off.page);

    expect(withoutStubbed.shellPaddingTop).toBeCloseTo(STUB_INSET_PX, 1);
    expect(withBandStubbed.shellPaddingTop).toBeCloseTo(STUB_INSET_PX + CLEARANCE_PX, 1);
    // Spelled out as its own assertion because it is the failure mode, not a
    // corollary: the gated shell must never be FLUSHER than the ungated one.
    expect(withBandStubbed.shellPaddingTop).toBeGreaterThan(withoutStubbed.shellPaddingTop);
  } finally {
    await on.close();
    await off.close();
  }
});
