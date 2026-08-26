// #213 — the media-viewer modal image must pinch-zoom + pan, and the gesture
// must stay CONFINED to the viewer (no page-zoom, no body-scroll bleed).
// #1805 — the PAN half is the browser's own scroller now; only the pinch is
// still synthesized.
//
// WHY the pinch is hand-rolled: iOS-1 (2026-05-17) locked the app viewport
// (`maximum-scale=1, user-scalable=no`) so cic feels like an app, not a
// website — that kills the browser's native pinch app-wide with no per-element
// opt-out. So the modal image synthesizes it in JS (lib/pinchZoom.ts geometry +
// element-level {passive:false} touch listeners in MediaViewerModal's
// ZoomableImage) and applies a CSS `transform` to the <img> alone.
//
// WHY the pan is NOT, since #1805: that lock governs PAGE ZOOM and says nothing
// about element scrolling. Measured on a standalone chromium/iPhone-15 bench
// through the real touch pipeline: an `overflow: auto` box scrolled 112px under
// the lock against 128px without it, where the whole question was whether it
// would be zero.
//
// FOUR guards, one per what is provable where:
//
//   1. WIRING (chromium, untagged): the synthesized pinch is wired end-to-end.
//      Chromium supports the Touch/TouchEvent constructors; webkit's are
//      unreliable (feedback_playwright_webkit_not_ios_scroll).
//   2. NON-CLAIM (chromium, untagged): a ONE-finger touchmove must come back
//      un-prevented. This is the inverse of what #213 asserted, and it is the
//      whole of #1805 at the JS layer — a blanket preventDefault leaves every
//      other symptom in place while the browser simply never scrolls.
//   3. GEOMETRY (chromium, untagged): a REAL one-finger drag, dispatched
//      through chromium's own input pipeline over CDP rather than as a DOM
//      event, moves the visible portion of the picture. Asserted as pixels of
//      painted displacement, not as "the node exists".
//   4. CSS CONTRACT + scrollable area (@webkit, iPhone 15): the declarations
//      and the fact that zooming creates real overflow, on the engine this
//      issue is actually about.
//
// 🔴 What NO leg here proves, and what therefore stays a dogfood call: the
// touch DRAG itself on WebKit. Playwright's WebKit backend exposes
// `Input.dispatchTapEvent` and nothing else for touch (playwright-core
// wkInput.js), and `mouse.wheel` is refused outright in mobile WebKit, so there
// is no way to drive a pan there — a zero from that engine would measure the
// harness, not the product. Momentum, rubber-band, and whether iOS starts a
// rubber-band before the dismiss binder's claim lands are all on a real phone.

import type { CDPSession, Page } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { openMediaViewerInPlace, uploadSizedImageAndGetLink } from "../fixtures/mediaViewer";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Big enough that the viewer renders a MEASURABLE box on both projects. The
// shared 1×1 constant cannot be used for anything geometric: the viewer caps an
// image with max-width/max-height and never scales one up, so on 1×1 every
// assertion about displacement is answered by one pixel whether or not the
// feature works (see uploadSizedImageAndGetLink).
const IMAGE_SIZE = { width: 400, height: 300 };

// Must match DOUBLE_TAP_MS in MediaViewerModal.tsx. Used only to SEPARATE two
// attempts so they cannot pair into a spurious double-tap — it is the
// protocol's own window, not a guess at how slow the machine is.
const DOUBLE_TAP_MS = 300;

// Upload an image and open it in the media viewer, then narrow to the ZOOMABLE
// <img> and the scroller that now wraps it.
//
// The door itself (upload → anchor → in-place click → dialog visible) is
// fixtures/mediaViewer.ts since #1441. The extra barrier below stays here: it
// is image-and-zoom specific, and it is also the locator this spec returns.
// `openMediaViewerInPlace` and not the plain opener because #219's harness
// (which this mirrors) needs the anchor's OWN click, with no Playwright
// scroll-into-view.
async function openImageViewer(page: Page) {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const { link } = await uploadSizedImageAndGetLink(page, "x213.png", IMAGE_SIZE);
  const viewer = await openMediaViewerInPlace(page, link);

  const img = viewer.locator(".media-viewer-media--zoomable");
  await expect(img).toBeVisible({ timeout: 5_000 });
  const scroller = viewer.locator(".media-viewer-zoom-scroller");
  await expect(scroller).toBeVisible({ timeout: 5_000 });
  return { viewer, img, scroller };
}

// Chromium's real input pipeline. `Emulation.setTouchEmulationEnabled` rather
// than a `test.use({ hasTouch: true })` on the project: the context options
// stay exactly what every other chromium spec boots with, so nothing about the
// app's own startup changes to serve this one file.
async function touchPipeline(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  return cdp;
}

async function cdpTap(cdp: CDPSession, x: number, y: number): Promise<void> {
  const point = [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

// Drag one finger from (x, y) upward by `dy`, in steps, through the browser's
// own gesture recogniser.
async function cdpDragUp(cdp: CDPSession, page: Page, x: number, y: number, dy: number) {
  const point = (at: number) => [{ x, y: at, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(y) });
  for (let moved = 10; moved <= dy; moved += 10) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(y - moved) });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

// Where the picture is PAINTED, relative to the scroller's own frame. This is
// the geometric oracle: with `transform-origin: 0 0` the painted top sits at
// exactly minus the scroll offset, so it moves if and only if the scroller
// really panned. Reading `scrollTop` alone would pass on a scroller that
// scrolls nothing visible.
async function paintedOffset(page: Page): Promise<{ dx: number; dy: number; scrollTop: number }> {
  return page.evaluate(() => {
    const scroller = document.querySelector(".media-viewer-zoom-scroller");
    const img = document.querySelector(".media-viewer-media--zoomable");
    if (scroller === null || img === null) throw new Error("zoomable image gone");
    const s = scroller.getBoundingClientRect();
    const i = img.getBoundingClientRect();
    return { dx: i.left - s.left, dy: i.top - s.top, scrollTop: scroller.scrollTop };
  });
}

async function zoomState(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector(".media-viewer-zoom-scroller");
    const img = document.querySelector(".media-viewer-media--zoomable");
    if (scroller === null || img === null) throw new Error("zoomable image gone");
    return {
      scale: new DOMMatrixReadOnly(getComputedStyle(img).transform).a,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    };
  });
}

test("#213 — a synthesized two-finger pinch scales the modal image (chromium)", async ({
  page,
}) => {
  test.slow();
  const { img } = await openImageViewer(page);

  // Baseline: an un-pinched image sits at scale 1 (no scale() → matrix a=1).
  const before = await img.evaluate((el) => getComputedStyle(el).transform);
  // Either "none" or a matrix with a-scale 1.
  expect(before === "none" || before.includes("matrix(1,")).toBeTruthy();

  // Fire a two-finger pinch on the <img>: fingers 100px apart → 300px apart
  // (3× the start distance) → the geometry scales toward 3× (clamped to MAX 4).
  const scaledUp = await img.evaluate((el) => {
    const cx = 200;
    const cy = 200;
    const twoTouches = (halfGap: number) => [
      new Touch({ identifier: 1, target: el, clientX: cx - halfGap, clientY: cy }),
      new Touch({ identifier: 2, target: el, clientX: cx + halfGap, clientY: cy }),
    ];
    const fire = (type: "touchstart" | "touchmove", touches: Touch[]): void => {
      el.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches,
          targetTouches: touches,
          changedTouches: touches,
        }),
      );
    };
    fire("touchstart", twoTouches(50)); // 100px apart
    fire("touchmove", twoTouches(150)); // 300px apart → 3×
    // Read the applied scale from the computed matrix (a component).
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return m.a;
  });

  // 3× requested, clamped to [1,4] → strictly greater than 1.
  expect(scaledUp).toBeGreaterThan(1.5);
});

test("#1805 — a ONE-finger touchmove on the modal image is NOT claimed (chromium)", async ({
  page,
}) => {
  test.slow();
  const { img } = await openImageViewer(page);

  // Until #1805 EVERY cancelable touchmove was preventDefault'd, which is what
  // kept the browser from scrolling. `dispatchEvent` returns false iff a
  // listener called preventDefault — a JS-level fact independent of
  // `touch-action`, so it is deterministic in chromium even though a synthetic
  // event cannot drive a real pixel scroll.
  //
  // Both branches in one evaluate, because the interesting assertion is the
  // CONTRAST: two fingers still ours, one finger the browser's. A spec that
  // only checked the one-finger case would go green on a component that had
  // stopped claiming anything at all, pinch included.
  const claims = await img.evaluate((el) => {
    const touch = (x: number, id: number) =>
      new Touch({ identifier: id, target: el, clientX: x, clientY: 200 });
    const fire = (type: "touchstart" | "touchmove", touches: Touch[]): boolean =>
      el.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches,
          targetTouches: touches,
          changedTouches: touches,
        }),
      );
    fire("touchstart", [touch(200, 1)]);
    const oneFinger = !fire("touchmove", [touch(260, 1)]);
    fire("touchstart", [touch(150, 1), touch(250, 2)]);
    const twoFingers = !fire("touchmove", [touch(100, 1), touch(300, 2)]);
    return { oneFinger, twoFingers };
  });

  expect(claims.oneFinger).toBe(false);
  expect(claims.twoFingers).toBe(true);
});

test("#1805 — a real one-finger drag moves the visible portion of the zoomed image (chromium)", async ({
  page,
}) => {
  test.slow();
  const { scroller } = await openImageViewer(page);
  const cdp = await touchPipeline(page);

  const box = await scroller.boundingBox();
  if (box === null) throw new Error("scroller has no box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Double-tap to 2×. Bounded retry rather than one attempt: the pairing window
  // is 300ms of wall clock and a loaded CI box can miss it. A missed attempt
  // leaves the scale AT 1, so the loop cannot overshoot, and the wait between
  // attempts is the window itself so two attempts can never pair with each
  // other.
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await zoomState(page)).scale > 1) break;
    await cdpTap(cdp, cx, cy);
    await cdpTap(cdp, cx, cy);
    await page.waitForTimeout(DOUBLE_TAP_MS + 100);
  }

  // PRECONDITION, and the load-bearing half of #1805: a CSS transform does not
  // change layout, so without the sizer the scaled image would create no
  // overflow at all and there would be nothing for any drag to move. Asserted
  // before the gesture (anti-hollow-green) — if this is an equality the test
  // that follows is measuring nothing.
  const zoomed = await zoomState(page);
  expect(zoomed.scale).toBeGreaterThan(1.5);
  expect(zoomed.scrollHeight).toBeGreaterThan(zoomed.clientHeight + 50);

  const before = await paintedOffset(page);
  await cdpDragUp(cdp, page, cx, cy, 80);
  const after = await paintedOffset(page);

  // The picture moved UP by the distance the scroller scrolled: painted
  // displacement and scroll offset are the same number seen twice, and
  // asserting both is what separates "the scroller moved" from "the reader saw
  // a different part of the picture".
  expect(after.scrollTop).toBeGreaterThan(before.scrollTop);
  expect(after.dy).toBeLessThan(before.dy - 20);
  expect(Math.abs(after.dy + after.scrollTop)).toBeLessThan(2);
});

test("@webkit #1805 — the zoomable modal image and its scroller declare the pan (iPhone 15)", async ({
  page,
}) => {
  test.slow();
  const { img, scroller } = await openImageViewer(page);

  // The load-bearing CSS contract, on the real webkit target. `none` on the
  // <img> — the pre-#1805 value — closes the scroller that wraps it, because
  // the UA intersects touch-action from the HIT TARGET up to the scroll
  // container: measured on the bench at 0px against 130px. Reverting either
  // declaration turns this red.
  expect(await img.evaluate((el) => getComputedStyle(el).touchAction)).toBe("pan-x pan-y");
  expect(await img.evaluate((el) => getComputedStyle(el).transformOrigin)).toBe("0px 0px");
  const style = await scroller.evaluate((el) => {
    const s = getComputedStyle(el);
    return { touchAction: s.touchAction, overflowY: s.overflowY, overscroll: s.overscrollBehaviorY };
  });
  expect(style.touchAction).toBe("pan-x pan-y");
  expect(style.overflowY).toBe("auto");
  expect(style.overscroll).toBe("contain");
});

test("@webkit #1805 — zooming creates a real scrollable area, and scrolling moves the picture (iPhone 15)", async ({
  page,
}) => {
  test.slow();
  const { scroller } = await openImageViewer(page);

  const box = await scroller.boundingBox();
  if (box === null) throw new Error("scroller has no box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Real taps: `page.touchscreen.tap` is `Input.dispatchTapEvent`, which is the
  // ONE touch verb Playwright's WebKit backend exposes. Same bounded-retry
  // reasoning as the chromium leg.
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await zoomState(page)).scale > 1) break;
    await page.touchscreen.tap(cx, cy);
    await page.touchscreen.tap(cx, cy);
    await page.waitForTimeout(DOUBLE_TAP_MS + 100);
  }

  const zoomed = await zoomState(page);
  expect(zoomed.scale).toBeGreaterThan(1.5);
  // The whole point of the sizer, on the engine the issue is about: a transform
  // alone leaves scrollHeight === clientHeight and there is nothing to pan.
  expect(zoomed.scrollHeight).toBeGreaterThan(zoomed.clientHeight + 50);

  // The DRAG cannot be driven here (see the header), so what is asserted is the
  // consequence a drag would produce: the scroller is real, and moving it moves
  // the painted picture rather than leaving it pinned under a clipped box.
  const before = await paintedOffset(page);
  await page.evaluate(() => {
    const el = document.querySelector(".media-viewer-zoom-scroller");
    if (el !== null) el.scrollTop = 60;
  });
  const after = await paintedOffset(page);
  expect(after.scrollTop).toBe(60);
  expect(Math.abs(after.dy - (before.dy - 60))).toBeLessThan(2);
});
