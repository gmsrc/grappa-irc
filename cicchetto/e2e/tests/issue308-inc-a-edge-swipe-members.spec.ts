// #308 INC-A — the right-edge swipe opens the members drawer (gesture 1),
// an ADDITIVE second door onto the permanent right rail (the BottomBar stays
// the primary nav — #71 ruling). This e2e guards the WIRING + the hard
// constraint, NOT the iOS feel:
//
//   * chromium, untagged — chromium's TouchEvent/Touch constructors are
//     reliable (webkit's are not — feedback_playwright_webkit_not_ios_scroll),
//     so we synthesize the gesture in-page. A NARROW viewport forces
//     isMobile() true so `.shell-mobile` mounts and the edge directive binds.
//   * The FEEL (does a real finger-drag feel right, does native momentum
//     survive) is a device call vjt dogfoods post-deploy — synthetic events
//     can't drive real pixel-scroll.
//
// The load-bearing gates are the swipe/touchGesture unit tests (jsdom); this
// e2e proves the directive is wired to the real Shell + opens the real drawer,
// and — the hard constraint — that a VERTICAL drag is left untouched (never
// preventDefaulted), so native vertical scroll survives.
import type { Page } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// iPhone-15-ish portrait: narrow enough for isMobile() (max-width query).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const CHANNEL = AUTOJOIN_CHANNELS[0];

type Pt = { x: number; y: number };

// Synthesize a touch gesture on `.shell-mobile`: touchstart at pts[0],
// a touchmove per interior point, touchend at the last. Returns whether ANY
// touchmove was preventDefaulted — dispatchEvent returns false iff a listener
// called preventDefault (the claim signal, read exactly as issue123 does).
async function synthEdgeGesture(page: Page, pts: Pt[]): Promise<{ prevented: boolean }> {
  return await page.evaluate((points) => {
    const root = document.querySelector(".shell-mobile");
    if (!(root instanceof HTMLElement)) throw new Error(".shell-mobile not found");
    const mk = (p: { x: number; y: number }) =>
      new Touch({ identifier: 1, target: root, clientX: p.x, clientY: p.y });
    const fire = (type: "touchstart" | "touchmove" | "touchend", p: { x: number; y: number }) => {
      const t = mk(p);
      const active = type === "touchend" ? [] : [t];
      return root.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: active,
          targetTouches: active,
          changedTouches: [t],
        }),
      );
    };
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) throw new Error("need at least a start and an end point");
    fire("touchstart", first);
    let prevented = false;
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i];
      if (p && !fire("touchmove", p)) prevented = true;
    }
    fire("touchend", last);
    return { prevented };
  }, pts);
}

async function openChannel(page: Page): Promise<void> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, getSeededVjt());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
}

test("issue308 INC-A — right-edge left-swipe opens the members drawer", async ({ page }) => {
  await openChannel(page);
  const W = await page.evaluate(() => window.innerWidth);
  await expect(page.locator(".shell-members.open")).toHaveCount(0); // starts closed

  const { prevented } = await synthEdgeGesture(page, [
    { x: W - 5, y: 400 },
    { x: W - 70, y: 404 },
    { x: W - 140, y: 408 },
    { x: W - 195, y: 410 },
  ]);

  await expect(page.locator(".shell-members.open")).toBeVisible();
  expect(prevented).toBe(true); // claimed the horizontal gesture
});

// THE hard constraint, full-stack: a vertical drag STARTING at the right edge
// is never claimed → never preventDefaulted → the browser owns the vertical
// scroll, and no drawer opens. If this ever preventDefaults, native scroll is
// broken — the single most important interaction (#308).
test("issue308 INC-A — a vertical drag from the edge never hijacks scroll (no open, no preventDefault)", async ({
  page,
}) => {
  await openChannel(page);
  const W = await page.evaluate(() => window.innerWidth);

  const { prevented } = await synthEdgeGesture(page, [
    { x: W - 5, y: 200 },
    { x: W - 3, y: 300 },
    { x: W - 6, y: 430 },
    { x: W - 5, y: 520 },
  ]);

  expect(prevented).toBe(false); // vertical was left entirely to the browser
  await expect(page.locator(".shell-members.open")).toHaveCount(0);
});

test("issue308 INC-A — a horizontal swipe from the CENTER does not open the drawer (zone separation)", async ({
  page,
}) => {
  await openChannel(page);
  const W = await page.evaluate(() => window.innerWidth);

  const { prevented } = await synthEdgeGesture(page, [
    { x: Math.round(W / 2), y: 400 },
    { x: Math.round(W / 2) - 80, y: 404 },
    { x: Math.round(W / 2) - 170, y: 408 },
  ]);

  expect(prevented).toBe(false); // center gesture is not armed → never claims
  await expect(page.locator(".shell-members.open")).toHaveCount(0);
});
