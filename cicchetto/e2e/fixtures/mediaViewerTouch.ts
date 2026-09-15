// The media viewer's TOUCH harness: how a gesture is driven at it, and what the
// browser says about the result. The #1441 lift one floor down —
// fixtures/mediaViewer.ts owns the DOOR (upload, open, close), this owns the
// GESTURES and the geometric oracles, because issue 2208 gave every one of them
// a second consumer and a copy-with-tweaks is how the door came to have thirteen
// of them.
//
// THREE gestures, and they are not interchangeable:
//
//   * `zoomByDoubleTap` — real taps through the engine's own tap verb, so the
//     browser HIT-TESTS them. That is the whole of issue 2208's oracle: a tap
//     in the dead margin reaches a listener or it does not, and only a real
//     hit-test can tell the difference. A dispatched TouchEvent would be
//     delivered to whatever element the spec named and would answer the
//     question by assuming it.
//   * `cdpDragUp` — a real one-finger drag through chromium's input pipeline,
//     for the pan.
//   * `dragOnModal` — a DISPATCHED TouchEvent sequence on the modal, for the
//     swipe-to-dismiss. Dispatched on purpose: the binder's claim is a JS-level
//     fact (`preventDefault`) and the assertion is about the modal's own
//     transform, neither of which needs a hit-test.
//
// Nothing here can drive a touch DRAG on WebKit: Playwright's WebKit backend
// exposes `Input.dispatchTapEvent` and nothing else, so momentum, rubber-band
// and real iOS scroll physics stay a dogfood call — stated at length in
// issue213-pinch-zoom.spec.ts's header.

import type { CDPSession, Locator, Page } from "@playwright/test";

// Must match DOUBLE_TAP_MS in MediaViewerModal.tsx. Used only to SEPARATE two
// attempts so they cannot pair into a spurious double-tap — it is the
// protocol's own window, not a guess at how slow the machine is.
export const DOUBLE_TAP_MS = 300;

// Chromium's real input pipeline. `Emulation.setTouchEmulationEnabled` rather
// than a `test.use({ hasTouch: true })` on the project: the context options
// stay exactly what every other chromium spec boots with, so nothing about the
// app's own startup changes to serve these files.
export async function touchPipeline(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  return cdp;
}

async function cdpTap(cdp: CDPSession, x: number, y: number): Promise<void> {
  const point = [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

// Double-tap to the 2× toggle, retried up to four times.
//
// A bounded retry rather than one attempt, and it is not a timeout in disguise:
// the pairing window is 300ms of WALL CLOCK, and a loaded CI box can miss it
// between two round trips. A missed attempt leaves the scale AT 1 — the toggle
// only fires when the pair lands — so the loop cannot overshoot into a zoom-out,
// and the wait between attempts is the window itself, which is what makes two
// attempts unable to pair with each other. The caller asserts the scale
// afterwards, so a loop that never lands is a red and not a silent skip.
//
// `tap` is the engine's own tap verb in both projects: CDP on chromium,
// `page.touchscreen.tap` (`Input.dispatchTapEvent`) on webkit.
export async function zoomByDoubleTap(
  page: Page,
  cdp: CDPSession | null,
  x: number,
  y: number,
): Promise<void> {
  const tap = async (): Promise<void> => {
    if (cdp === null) await page.touchscreen.tap(x, y);
    else await cdpTap(cdp, x, y);
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await zoomState(page)).scale > 1) return;
    await tap();
    await tap();
    await page.waitForTimeout(DOUBLE_TAP_MS + 100);
  }
}

// Drag one finger from (x, y) upward by `dy`, in steps, through the browser's
// own gesture recogniser. Chromium only — see the header.
export async function cdpDragUp(
  cdp: CDPSession,
  page: Page,
  x: number,
  y: number,
  dy: number,
): Promise<void> {
  const point = (at: number) => [{ x, y: at, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(y) });
  for (let moved = 10; moved <= dy; moved += 10) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: point(y - moved),
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

// One vertical drag on the modal, plus the browser's own reading of where the
// modal sat before and during it. Body inlined in the page rather than passed
// as a stringified function: `new Function` in page context is eval, and cic
// serves a CSP with no `unsafe-eval` — the drag would throw where it matters
// and nowhere else.
//
// `dy` is applied in TWO moves because the binder claims LATE: it decides on a
// touchmove, never on the touchstart. `lift` is optional so a caller can read
// the paint with the finger still down, which is the only moment it exists.
export async function dragOnModal(
  viewer: Locator,
  dy: number,
  lift: boolean,
): Promise<{ before: number; after: number }> {
  return viewer.evaluate(
    (el, opts) => {
      // The vertical component of the computed matrix — what the browser
      // actually resolved, not the inline string we wrote.
      const verticalOffset = (): number => new DOMMatrixReadOnly(getComputedStyle(el).transform).f;
      const at = (y: number): Touch =>
        new Touch({ identifier: 1, target: el, clientX: 200, clientY: y });
      const fire = (type: string, touch: Touch): void => {
        const list = type === "touchend" ? [] : [touch];
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: list,
            targetTouches: list,
            changedTouches: [touch],
          }),
        );
      };
      const y0 = 200;
      const before = verticalOffset();
      fire("touchstart", at(y0));
      fire("touchmove", at(y0 + Math.sign(opts.dy) * 40));
      fire("touchmove", at(y0 + opts.dy));
      const after = verticalOffset();
      if (opts.lift) fire("touchend", at(y0 + opts.dy));
      return { before, after };
    },
    { dy, lift },
  );
}

// Where the picture is PAINTED, relative to the scroller's own frame. This is
// the geometric oracle: with `transform-origin: 0 0` the painted top sits at
// exactly minus the scroll offset, so it moves if and only if the scroller
// really panned. Reading `scrollTop` alone would pass on a scroller that
// scrolls nothing visible.
export async function paintedOffset(
  page: Page,
): Promise<{ dx: number; dy: number; scrollTop: number }> {
  return page.evaluate(() => {
    const scroller = document.querySelector(".media-viewer-zoom-scroller");
    const img = document.querySelector(".media-viewer-media--zoomable");
    if (scroller === null || img === null) throw new Error("zoomable image gone");
    const s = scroller.getBoundingClientRect();
    const i = img.getBoundingClientRect();
    return { dx: i.left - s.left, dy: i.top - s.top, scrollTop: scroller.scrollTop };
  });
}

export async function zoomState(
  page: Page,
): Promise<{ scale: number; scrollHeight: number; clientHeight: number }> {
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
