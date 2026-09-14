// issue 2128 — a banner whose message carries an unbreakable token wider than
// the screen must still hand the operator its controls.
//
// ## Why this spec is here and not in vitest
//
// The slot's unit tests live in `src/__tests__/BannerSlot.test.tsx`, and they
// cannot answer this question. Measured on this branch rather than assumed:
// rendering the slot under vitest and reading `getBoundingClientRect()` gives
// `left=0 right=0 width=0 height=0` for the slot, the action and the ×, and
// `offsetWidth` 0 — jsdom lays nothing out. Injecting the real theme as a
// `<style>` does not rescue it either: `document.styleSheets` holds the sheet
// with `cssRules.length === 0`, so `getComputedStyle(slot).display` reads
// `block` and the ×'s `width` reads `auto`. Not one declaration of the theme
// reaches an element there, which rules out the weaker "assert the cascade
// asked for it" oracle at the same time as the geometric one.
//
// So the observation has to happen in a real engine, which is this harness.
//
// ## What it measures
//
// A DCC offer is the longest banner message the app ships — the peer declares
// the filename — so it is the cheapest way to put a run of unbreakable text
// into the slot from OUTSIDE the client. But the defect belongs to the SLOT:
// any banner carrying a URL, a channel name or a hostname loses its controls
// the same way, and the cure (`flex-wrap` + `min-width: 0` +
// `overflow-wrap: anywhere` on `.error-banner` / `.error-banner-message`) is
// on the shared rules, not on anything DCC-shaped.
//
// The offer is deliberately LONGER than the server will show: the banner reads
// `Grappa.Dcc.Report.display_filename/1`, which truncates at
// `@filename_max_bytes` (120) and appends an ellipsis, so what reaches the DOM
// is the worst case the wire can produce and the locator's 120-character head
// fails the moment that cap shrinks.
//
// Two widths, and both are the point: 393 CSS px is the reported device
// (Android PWA, 1080x2340 at dsf 2.75), 320 CSS px is the contract the issue
// sets. The assertions are the same at both.
//
// The spec LOGS IN at a desktop width and narrows only to measure. That is
// not incidental: `selectChannel` taps when `isMobileViewport(page)`, and the
// desktop project has `hasTouch: false`, so a phone-width login would throw
// "the page does not support tap" before reaching anything under test. It
// also keeps the spec about the slot's CSS rather than about which shell
// branch is mounted — the banner region is `position: fixed` at the top of
// the viewport in both.
//
// 🔴 WHAT THIS DOES NOT COVER: one engine. The default project is chromium,
// which is the reporter's engine family (Blink) but is not WebKit and is not
// a real Android device — per `feedback_playwright_webkit_not_ios_scroll` a
// desktop engine at a phone viewport proves layout at that width, not the
// platform's own behaviour. The defect is plain CSS flexbox with no
// engine-specific feature in it, which is why one engine is judged enough
// here; it is a judgement, not a measurement.

import type { Locator, Page } from "@playwright/test";
import {
  dccOfferBanner,
  dccOfferBannerRefuse,
  loginAs,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

// TEST-NET-3 (RFC 5737) as the historical 32-bit unsigned IPv4 integer, for
// the same reason issue2089's spec uses it: `Grappa.Dcc.Policy.admit_offer/1`
// runs the SSRF gate BEFORE the offer is held, so a docker-private address is
// dropped and no banner ever appears.
const TESTNET3_U32 = 3_405_803_777;
const OFFER_PORT = 59_998;
const OFFER_SIZE = 4096;

// ONE unbreakable run — no hyphen, no space, nothing a line breaker may split
// at — so the message's min-content width is the whole filename. 224 bytes,
// comfortably past the server's 120-byte display cap.
const FILENAME_RUN = "Grappa2128UnbreakableFilenameRun";
const OFFERED_FILENAME = FILENAME_RUN.repeat(7);
// What the banner will actually carry: the first 120 bytes. Used as the
// locator's text, so a cap that shrank would fail to collect the banner
// rather than silently weaken the case under test.
const DISPLAYED_HEAD = OFFERED_FILENAME.slice(0, 120);

// The reported phone, then the contract width.
const WIDTHS = [393, 320] as const;
// Where the spec logs in and where it cleans up — see the header.
const DESKTOP = { width: 1280, height: 800 } as const;

test.use({ viewport: { ...DESKTOP } });

interface SlotGeometry {
  slot: { left: number; right: number; width: number } | null;
  action: { left: number; right: number; width: number; height: number } | null;
  dismiss: { left: number; right: number; width: number; height: number } | null;
  paddingRight: number;
  viewportWidth: number;
}

// One round trip for every number, read off the LIVE layout. The slot itself
// is the outer reference box (it is the `position: fixed; left: 0; right: 0`
// region's child, so its width IS the viewport's) and `paddingRight` is read
// rather than assumed, so the right-alignment assertion carries no magic
// constant.
async function slotGeometry(banner: Locator): Promise<SlotGeometry> {
  return banner.evaluate((slot: HTMLElement): SlotGeometry => {
    const rect = (el: Element | null) => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, height: r.height };
    };
    return {
      slot: rect(slot),
      action: rect(slot.querySelector(".error-banner-action")),
      dismiss: rect(slot.querySelector(".error-banner-dismiss")),
      paddingRight: Number.parseFloat(window.getComputedStyle(slot).paddingRight),
      viewportWidth: window.innerWidth,
    };
  });
}

function assertControlsReachable(geometry: SlotGeometry, width: number): void {
  const { slot, action, dismiss, paddingRight, viewportWidth } = geometry;
  expect(viewportWidth).toBe(width);
  expect(slot).not.toBeNull();
  expect(action).not.toBeNull();
  expect(dismiss).not.toBeNull();
  if (slot === null || action === null || dismiss === null) return;

  // THE defect. Both controls entirely within the slot — which is the
  // viewport, and which has no overflow affordance, so a control outside it
  // is not scrollable to, it is unreachable.
  for (const [name, box] of [
    ["action", action],
    ["dismiss", dismiss],
  ] as const) {
    expect(box.left, `${name} left edge at ${width}px`).toBeGreaterThanOrEqual(slot.left);
    expect(box.right, `${name} right edge at ${width}px`).toBeLessThanOrEqual(slot.right);
    expect(box.right, `${name} right edge vs viewport at ${width}px`).toBeLessThanOrEqual(width);
  }

  // #459 — the × is 44px DELIBERATELY. Buying the horizontal room back by
  // shrinking the tap target is the wrong cure, and this is the assertion
  // that says so: it goes red on that cure while the two above go green.
  expect(dismiss.width, `dismiss tap width at ${width}px`).toBeGreaterThanOrEqual(44);
  expect(dismiss.height, `dismiss tap height at ${width}px`).toBeGreaterThanOrEqual(44);

  // Order preserved: the action precedes the ×, whether they share the
  // message's line or have wrapped onto their own.
  expect(action.right, `action precedes × at ${width}px`).toBeLessThanOrEqual(dismiss.left);

  // And `margin-left: auto` still right-aligns the pair — per FLEX LINE, so
  // this holds in the wrapped case too. Flush against the content box's right
  // edge, within a pixel of sub-pixel rounding.
  expect(
    Math.abs(dismiss.right - (slot.right - paddingRight)),
    `× is right-aligned at ${width}px`,
  ).toBeLessThanOrEqual(1);
}

async function refuseQuietly(page: Page): Promise<void> {
  // Widen first: pre-cure the × sits outside a fixed region, where no scroll
  // can bring it into reach, so a failing run could not clean up after itself
  // at a phone width. A stranded `:info` banner is a cascade poisoner for
  // every later spec whose layout the fixed region shifts.
  await page.setViewportSize({ ...DESKTOP });
  await dccOfferBannerRefuse(page, DISPLAYED_HEAD).click({ timeout: 10_000 });
}

test("issue 2128 — a banner's controls stay inside a narrow viewport", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  // The barrier that the operator's IRC session is REGISTERED under
  // `specNick()`: the self-JOIN line for the autojoined channel. Without it
  // the peer's PRIVMSG can reach the ircd before the nick exists and earn a
  // 401 instead of an offer.
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: `dcc2128-${crypto.randomUUID().slice(0, 6)}` });
  try {
    peer.dccSend(specNick(), OFFERED_FILENAME, TESTNET3_U32, OFFER_PORT, OFFER_SIZE);

    const banner = dccOfferBanner(page, DISPLAYED_HEAD);
    await expect(banner).toBeVisible({ timeout: 15_000 });

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 851 });
      // Re-read the geometry AFTER the resize has been laid out. `boundingBox`
      // on the slot is the barrier: it cannot answer before layout has run.
      await expect
        .poll(async () => (await slotGeometry(banner)).viewportWidth, { timeout: 10_000 })
        .toBe(width);
      assertControlsReachable(await slotGeometry(banner), width);
    }
  } finally {
    await refuseQuietly(page).catch(() => {});
    await peer.disconnect("2128 done").catch(() => {});
  }
});
