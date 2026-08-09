// #1041 — the left-edge swipe opens the mobile channel sidebar, and that
// sidebar is ABSENT from the DOM whenever it is not on screen: mounted when the
// gesture commits, destroyed when it hides. Both halves are asserted here as
// VISIBLE outcomes (element count + on-screen geometry), not as a class flip.
//
// Same harness + same limits as #308 INC-A's sibling spec:
//   * chromium, untagged — chromium's TouchEvent/Touch constructors are
//     reliable (webkit's are not — Playwright webkit ≠ real iOS scroll), so the
//     gesture is synthesized in-page. A NARROW viewport forces isMobile() true
//     so `.shell-mobile` mounts and the edge directive binds.
//   * The FEEL (does the drag read right under a real finger, does iOS momentum
//     survive, does the enter animation look like a drawer rather than a pop)
//     is a DEVICE call: synthetic events drive no pixel-scroll and chromium is
//     not iOS Safari. That part is vjt's on-device dogfood, declared as such —
//     this spec does not cover it and must not be read as if it did.
import type { Page } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// iPhone-15-ish portrait: narrow enough for isMobile() (max-width query).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const CHANNEL = AUTOJOIN_CHANNELS[0];

// The mobile drawer instance specifically — the desktop branch mounts the same
// `.shell-sidebar` class in its grid, and scoping under `.shell-mobile` keeps
// this spec honest if that ever renders side by side.
const SIDEBAR = ".shell-mobile .shell-sidebar";

type Pt = { x: number; y: number };

// Synthesize a touch gesture on `.shell-mobile`: touchstart at pts[0], a
// touchmove per interior point, touchend at the last. Returns whether ANY
// touchmove was preventDefaulted — dispatchEvent returns false iff a listener
// called preventDefault (the claim signal). Verbatim shape from the #308 spec.
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

// left→center: the opening gesture.
function leftEdgeOpenSwipe(): Pt[] {
  return [
    { x: 5, y: 400 },
    { x: 70, y: 404 },
    { x: 140, y: 408 },
    { x: 195, y: 410 },
  ];
}

async function openChannel(page: Page): Promise<void> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, getSeededVjt());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
}

// Fully slid in: the panel's left edge has reached the viewport's. Asserting
// GEOMETRY, not the `.open` class — a drawer that is classed open while parked
// at translateX(-100%) is off-screen and the operator sees nothing. Polled
// because the enter animation takes 200ms.
async function expectSlidIn(page: Page): Promise<void> {
  await expect.poll(async () => (await page.locator(SIDEBAR).boundingBox())?.x ?? null).toBe(0);
}

test("issue1041 — left-edge right-swipe mounts the sidebar and slides it on screen", async ({
  page,
}) => {
  await openChannel(page);

  // The premise: on mobile the sidebar is not hidden, it is ABSENT.
  await expect(page.locator(SIDEBAR)).toHaveCount(0);

  const { prevented } = await synthEdgeGesture(page, leftEdgeOpenSwipe());

  expect(prevented).toBe(true); // claimed the horizontal gesture
  await expect(page.locator(SIDEBAR)).toBeVisible();
  await expectSlidIn(page);
  // …and it is the real Sidebar, not an empty shell: the channel row is there.
  await expect(page.locator(`${SIDEBAR} [data-window-name="${CHANNEL}"]`)).toBeVisible();
});

test("issue1041 — the backdrop tap hides the sidebar and DESTROYS it (no hidden box left behind)", async ({
  page,
}) => {
  await openChannel(page);
  await synthEdgeGesture(page, leftEdgeOpenSwipe());
  await expectSlidIn(page);

  // Tap the backdrop clear of the panel (the drawer caps at 18rem = 288px on a
  // 390px viewport, so x=350 is uncovered backdrop).
  await page.locator(".shell-drawer-backdrop.open").click({ position: { x: 350, y: 400 } });

  // THE ask: not `display:none`, not `translateX(-100%)` — gone. This is what
  // separates #1041 from the always-mounted `.shell-members` drawer, and it is
  // the assertion that fails if someone "simplifies" the deferred unmount into
  // a permanent mount with a class toggle.
  await expect(page.locator(SIDEBAR)).toHaveCount(0);
});

test("issue1041 — picking the ALREADY-selected row still dismisses the drawer", async ({
  page,
}) => {
  await openChannel(page);
  await synthEdgeGesture(page, leftEdgeOpenSwipe());
  await expectSlidIn(page);

  // Deliberately the row that is already active: a Shell-side effect watching
  // `selectedChannel()` — the obvious alternative to Sidebar's restored
  // `onSelect` prop — sees no change here and would leave the drawer stuck open
  // over the window the operator just asked for. This case is why the prop came
  // back, so it is the case that has to be pinned.
  await page.locator(`${SIDEBAR} [data-window-name="${CHANNEL}"] .sidebar-window-btn`).click();

  await expect(page.locator(SIDEBAR)).toHaveCount(0);
});

// THE hard constraint (#308), inherited by the new arm: a vertical drag that
// STARTS at the left edge is never claimed → never preventDefaulted → the
// browser owns the vertical scroll, and nothing mounts. If this ever
// preventDefaults, native scroll on the left third of every mobile screen is
// broken.
test("issue1041 — a vertical drag from the left edge never hijacks scroll (no mount, no preventDefault)", async ({
  page,
}) => {
  await openChannel(page);

  const { prevented } = await synthEdgeGesture(page, [
    { x: 5, y: 200 },
    { x: 7, y: 300 },
    { x: 4, y: 430 },
    { x: 5, y: 520 },
  ]);

  expect(prevented).toBe(false); // vertical was left entirely to the browser
  await expect(page.locator(SIDEBAR)).toHaveCount(0);
});

test("issue1041 — a rightward swipe from the CENTER does not mount the sidebar (zone separation)", async ({
  page,
}) => {
  await openChannel(page);

  const { prevented } = await synthEdgeGesture(page, [
    { x: 195, y: 400 },
    { x: 275, y: 404 },
    { x: 365, y: 408 },
  ]);

  expect(prevented).toBe(false); // center gesture is not armed → never claims
  await expect(page.locator(SIDEBAR)).toHaveCount(0);
});

// An open overlay is a CHILD of `.shell-mobile`, so its touches still bubble to
// the edge directive. Without the overlay guard in Shell the left swipe would
// stack a second drawer underneath the members drawer that is already up.
test("issue1041 — the left swipe is refused while the members drawer is open", async ({ page }) => {
  await openChannel(page);

  // #308 INC-A's own gesture: right→center opens members.
  await synthEdgeGesture(page, [
    { x: 385, y: 400 },
    { x: 320, y: 404 },
    { x: 250, y: 408 },
    { x: 195, y: 410 },
  ]);
  await expect(page.locator(".shell-members.open")).toBeVisible();

  await synthEdgeGesture(page, leftEdgeOpenSwipe());

  await expect(page.locator(SIDEBAR)).toHaveCount(0);
  await expect(page.locator(".shell-members.open")).toBeVisible(); // untouched
});
