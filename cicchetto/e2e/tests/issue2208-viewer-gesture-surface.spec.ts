// issue 2208 — the zoom gesture must start from the whole viewer body, not only
// from the pixels the picture happens to occupy.
//
// Reported by vjt on #grappa: «se mandi un immagine larga e bassa non devo
// andare a fare pinch sui 4 pixel di altezza, e posso vederla ingrandita in
// tutta la preview window». The touch listeners are on
// `.media-viewer-zoom-scroller` (ZoomableImage's bindScroller), and that box
// used to shrink-wrap the picture: a 1200x40 upload fits to roughly 1134x38
// inside a body floored at half the viewport by #2188, so ~160px above and
// ~160px below the picture were body, not scroller, and a touch there reached
// no listener at all.
//
// 🔴 EXPLICITLY NOT AN UPSCALE — vjt's ruling in the same report: «non voglio
// fare upscale delle immagini». The picture keeps its `object-fit: contain`
// size; only the box around it grew. That is what the second test measures, and
// it is the control that separates "the surface got bigger" from "the picture
// got bigger" — a fix that reached the <img> would turn the FIRST test green
// for the wrong reason.
//
// THE DISCRIMINATING INPUT IS THE IMAGE SHAPE, and nothing here works without
// it. On a square-ish picture the scroller and the picture very nearly coincide
// already, there is no dead margin to tap in, and every assertion below is
// answered identically before and after the fix. Wide-and-short (or
// tall-and-narrow) is the shape where the two boxes come apart — which is why
// #213's 400x300 could never have caught this and why this file uploads its own.
//
// WHAT IS PROVEN, and where:
//
//   1. THE GESTURE (chromium + @webkit iPhone 15): a double-tap dispatched at a
//      point that is inside the viewer body and OUTSIDE the picture zooms the
//      picture. Driven as a real hit-tested tap through the engine's own tap
//      verb, never as a dispatched TouchEvent — dispatching one at a named
//      element would answer the question by assuming it. The iPhone leg is not
//      decoration: the report is about a phone.
//   2. THE NON-UPSCALE (chromium): the rendered picture is the contain-fit of
//      its own intrinsic size and is a fraction of the surface's height, while
//      the surface is the body's content box. Both facts in one test, because
//      it is their COMBINATION that is the change.
//   3. THE #1438 CONTRACT, re-proven and not assumed (chromium): at fit nothing
//      overflows on either axis, so the browser has no pan to start and the
//      swipe-to-dismiss keeps the single-finger drag — on the bigger box, with
//      the shape that made it bigger.
//
// NOT PROVEN HERE: the pinch itself on WebKit (Playwright's WebKit backend
// exposes no touch-drag drive — see issue213-pinch-zoom.spec.ts's header), and
// the FEEL of any of it.

import type { Page } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { openMediaViewerInPlace, uploadSizedImageAndGetLink } from "../fixtures/mediaViewer";
import {
  dragOnModal,
  paintedOffset,
  touchPipeline,
  zoomByDoubleTap,
  zoomState,
} from "../fixtures/mediaViewerTouch";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// WIDE AND SHORT, which is the whole experiment. Wide enough that the fit is
// decided by the width cap on every project (so the picture spans the surface
// horizontally and leaves the dead margin on ONE axis, where it can be reasoned
// about), and short enough that the #2188 half-viewport floor leaves a margin
// far larger than any tap slop.
const IMAGE_SIZE = { width: 1200, height: 40 };

// The picture's aspect ratio, as the SOURCE states it. Used to check that what
// the browser rendered is a contain-fit of this upload and not something
// stretched to a box — derived from the constant above so the two cannot drift.
const ASPECT = IMAGE_SIZE.height / IMAGE_SIZE.width;

async function openWideImageViewer(page: Page) {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const { link } = await uploadSizedImageAndGetLink(page, "x2208.png", IMAGE_SIZE);
  const viewer = await openMediaViewerInPlace(page, link);

  const img = viewer.locator(".media-viewer-media--zoomable");
  await expect(img).toBeVisible({ timeout: 5_000 });
  const scroller = viewer.locator(".media-viewer-zoom-scroller");
  await expect(scroller).toBeVisible({ timeout: 5_000 });
  return { viewer, img, scroller };
}

// The three boxes this issue is about, as the browser painted them: the viewer
// body (the frame the reader sees), the scroller (the surface a gesture can
// start from) and the picture.
//
// `bodyContent` is the body's CONTENT box, which is what a stretched flex item
// fills, and it is computed rather than read: `clientWidth`/`clientHeight`
// INCLUDE padding. Measured the hard way — the first draft of this spec compared
// the scroller against the bare `clientWidth` and went red by exactly 14px,
// which is `.media-viewer-body`'s `padding: 0.5rem` twice over at cic's 14px
// root. The product was right and the ruler was wrong.
async function surfaceGeometry(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector(".media-viewer-body");
    const scroller = document.querySelector(".media-viewer-zoom-scroller");
    const img = document.querySelector(".media-viewer-media--zoomable");
    if (body === null || scroller === null || img === null) throw new Error("viewer gone");
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    };
    const padding = getComputedStyle(body);
    const padX = Number.parseFloat(padding.paddingLeft) + Number.parseFloat(padding.paddingRight);
    const padY = Number.parseFloat(padding.paddingTop) + Number.parseFloat(padding.paddingBottom);
    return {
      body: box(body),
      bodyContent: { width: body.clientWidth - padX, height: body.clientHeight - padY },
      scroller: box(scroller),
      image: box(img),
    };
  });
}

// A point inside the viewer body, vertically halfway between the body's top
// edge and the picture's — the margin that used to be dead. Returned with the
// margin it was cut from so the caller can refuse to run on a geometry that
// does not have one.
function deadMarginPoint(geometry: Awaited<ReturnType<typeof surfaceGeometry>>) {
  const margin = geometry.image.top - geometry.body.top;
  return {
    margin,
    x: geometry.body.left + geometry.body.width / 2,
    y: geometry.body.top + margin / 2,
  };
}

// The anti-vacuity guard, and it is the one assertion this file cannot do
// without. If the picture filled the body there would be no dead margin, the
// "dead" point would land on the picture, and the gesture would zoom whether or
// not the surface ever grew — a green measuring the upload, not the fix.
//
// 🔴 It is ALSO the upscale tripwire. The one change that would make this file
// pass for the wrong reason is stretching the picture to the box, and that is
// precisely the change that makes the margin vanish.
function expectARealDeadMargin(margin: number, imageHeight: number): void {
  expect(margin).toBeGreaterThan(40);
  expect(imageHeight).toBeLessThan(margin);
}

test("#2208 — a double-tap in the dead margin beside the picture zooms it (chromium)", async ({
  page,
}) => {
  test.slow();
  await openWideImageViewer(page);
  const cdp = await touchPipeline(page);

  const geometry = await surfaceGeometry(page);
  const dead = deadMarginPoint(geometry);
  expectARealDeadMargin(dead.margin, geometry.image.height);
  // And the point really is off the picture, with room to spare for the tap's
  // own 8px radius.
  expect(dead.y).toBeLessThan(geometry.image.top - 10);

  // A REAL tap, hit-tested by the browser. Before this issue the element under
  // this point was `.media-viewer-body`, which carries no listener, and the
  // double-tap toggle never fired.
  await zoomByDoubleTap(page, cdp, dead.x, dead.y);

  const zoomed = await zoomState(page);
  expect(zoomed.scale).toBeGreaterThan(1.5);

  // issue 2208's focus-point decision, MEASURED rather than argued. The anchor
  // is deliberately not clamped to the image box: a focus above the picture
  // computes a negative scroll, and the container's own assignment clamp — the
  // one authority that knows the bounds, per lib/pinchZoom.ts — bounds it at 0.
  // The vertical extent at 2x is still inside the surface, so a clamp in the
  // geometry would have produced the same pixel here and bought nothing.
  //
  // The horizontal axis is the control that keeps this from being a statement
  // about a scroller that simply cannot move: there the focus IS on the picture,
  // the zoom overflows, and the anchoring scrolls.
  const painted = await paintedOffset(page);
  expect(painted.scrollTop).toBe(0);
  expect(zoomed.scrollHeight).toBe(zoomed.clientHeight);
  expect(painted.scrollLeft).toBeGreaterThan(0);
  expect(zoomed.scrollWidth).toBeGreaterThan(zoomed.clientWidth);
});

// Both mobile projects, by the orthogonal tagging the config spells out:
// `@webkit` collects iPhone 15, `@touch` collects Pixel 7, and this assertion
// wants both — the report is about a phone, and the two engines resolve the
// flex centring with their own rounding.
test("@webkit @touch #2208 — the same dead-margin double-tap zooms on a phone (iPhone 15 + Pixel 7)", async ({
  page,
}) => {
  test.slow();
  await openWideImageViewer(page);

  const geometry = await surfaceGeometry(page);
  const dead = deadMarginPoint(geometry);
  expectARealDeadMargin(dead.margin, geometry.image.height);
  expect(dead.y).toBeLessThan(geometry.image.top - 10);

  // `page.touchscreen.tap` — `Input.dispatchTapEvent`, the ONE touch verb
  // Playwright's WebKit backend exposes, and enough for this question because
  // the double-tap toggle is two taps and no drag.
  await zoomByDoubleTap(page, null, dead.x, dead.y);

  expect((await zoomState(page)).scale).toBeGreaterThan(1.5);
});

test("#2208 — the surface grew to the body and the picture did not grow at all (chromium)", async ({
  page,
}) => {
  test.slow();
  await openWideImageViewer(page);

  const geometry = await surfaceGeometry(page);

  // THE SURFACE: the scroller is the body's content box on both axes. This is
  // the half that makes the gesture reachable.
  expect(Math.abs(geometry.scroller.width - geometry.bodyContent.width)).toBeLessThan(2);
  expect(Math.abs(geometry.scroller.height - geometry.bodyContent.height)).toBeLessThan(2);

  // THE PICTURE: unchanged, and stated three ways because "unchanged" is the
  // ruling and one loose assertion would let an upscale through.
  //
  //   * never wider than the bytes that were uploaded — `object-fit: contain`
  //     with no floor beneath it cannot scale a picture UP, and this is the
  //     assertion that says so in pixels;
  //   * still the contain-fit of THIS upload's aspect ratio, so it was not
  //     stretched on one axis;
  //   * and a small fraction of the surface it sits in, which is the same fact
  //     from the reader's side: the box is big, the picture is not.
  expect(geometry.image.width).toBeLessThanOrEqual(IMAGE_SIZE.width);
  expect(geometry.image.width).toBeLessThanOrEqual(geometry.bodyContent.width + 1);
  expect(geometry.image.height).toBeCloseTo(geometry.image.width * ASPECT, 0);
  expect(geometry.image.height).toBeLessThan(geometry.scroller.height / 3);

  // …and centred in the surface rather than parked in its corner, which is what
  // keeps the rendered result the one #2188 settled on. Measured on the
  // painted box, so a fix that filled the body by moving the picture fails here.
  const above = geometry.image.top - geometry.scroller.top;
  const below = geometry.scroller.height - geometry.image.height - above;
  expect(Math.abs(above - below)).toBeLessThan(2);
});

test("#2208 — at fit nothing overflows, so the swipe-to-dismiss keeps the drag (chromium)", async ({
  page,
}) => {
  test.slow();
  const { viewer } = await openWideImageViewer(page);

  // #1438's precondition, re-proven on the bigger box and with the shape that
  // made it bigger rather than inherited from a spec that uploads a 1x1 dot.
  // The dismiss binder keeps the single-finger drag only while the browser has
  // no pan to start: the sizer is zero at fit and the picture cannot outgrow a
  // scroller that is sized to hold it, so BOTH axes must come back equal. A
  // sub-pixel of overflow on either one hands the drag to the browser and the
  // viewer stops dismissing — silently, and only on a phone.
  const atFit = await zoomState(page);
  expect(atFit.scale).toBe(1);
  expect(atFit.scrollHeight).toBe(atFit.clientHeight);
  expect(atFit.scrollWidth).toBe(atFit.clientWidth);

  // And the OUTCOME, not just its precondition: half a viewport of pull, past
  // the commit fraction whatever that constant currently is, and the viewer
  // goes away.
  const half = Math.round((await page.evaluate(() => window.innerHeight)) / 2);
  await dragOnModal(viewer, half, true);

  await expect(viewer).toBeHidden({ timeout: 5_000 });
});
