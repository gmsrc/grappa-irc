import { describe, expect, it } from "vitest";
import {
  applyPinch,
  clamp,
  clampScale,
  DOUBLE_TAP_SCALE,
  distance,
  MAX_SCALE,
  MIN_SCALE,
  midpoint,
  rescaleScroll,
  type Scroll,
  toggleZoom,
} from "../lib/pinchZoom";

// The pure pinch geometry (gemello di swipe.ts) is DOM-free so it unit-tests
// without touch physics. Since #1805 a zoom state is a bare `scale`: the pan
// belongs to the browser's own scroller, so there is no `tx`/`ty` to confine
// and no `applyPan`/`maxTranslate`/`clampTransform` to test. What replaced them
// is `rescaleScroll` — the one thing the scroller CANNOT do for itself, because
// only we know which image point the fingers were holding.

describe("distance", () => {
  it("is the euclidean distance between two points", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("is zero for coincident points", () => {
    expect(distance({ x: 7, y: 9 }, { x: 7, y: 9 })).toBe(0);
  });
});

describe("midpoint", () => {
  it("is the average of the two points", () => {
    expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });
});

describe("clamp", () => {
  it("passes a value already in range through", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it("clamps below the floor and above the ceiling", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });
});

describe("clampScale", () => {
  it("keeps a scale within the allowed zoom range", () => {
    expect(clampScale(2)).toBe(2);
  });
  it("floors at MIN_SCALE (never zoom out past fit)", () => {
    expect(clampScale(0.3)).toBe(MIN_SCALE);
  });
  it("ceils at MAX_SCALE (no infinite zoom)", () => {
    expect(clampScale(99)).toBe(MAX_SCALE);
  });
});

describe("applyPinch", () => {
  it("scales relative to the gesture-start distance", () => {
    // fingers move twice as far apart → 2x.
    expect(applyPinch(1, 100, 200)).toBe(2);
  });

  it("compounds on the start scale (mid-gesture continuation)", () => {
    expect(applyPinch(2, 100, 150)).toBe(3);
  });

  it("clamps the resulting scale to MAX_SCALE", () => {
    expect(applyPinch(1, 100, 9999)).toBe(MAX_SCALE);
  });

  it("floors at MIN_SCALE when the fingers close past fit", () => {
    expect(applyPinch(3, 300, 10)).toBe(MIN_SCALE);
  });

  it("is a no-op when the start distance is zero (divide guard)", () => {
    expect(applyPinch(2, 0, 200)).toBe(2);
  });
});

describe("toggleZoom", () => {
  it("zooms an unzoomed image to the double-tap scale", () => {
    expect(toggleZoom(MIN_SCALE)).toBe(DOUBLE_TAP_SCALE);
  });

  it("resets a zoomed image back to fit", () => {
    expect(toggleZoom(3)).toBe(MIN_SCALE);
  });

  it("resets even a slightly-zoomed image (any scale above MIN)", () => {
    expect(toggleZoom(1.2)).toBe(MIN_SCALE);
  });
});

describe("rescaleScroll", () => {
  const AT_TOP: Scroll = { left: 0, top: 0 };

  it("keeps the point under the focus under the focus (the whole contract)", () => {
    // Container 200 wide, focus at its centre (100). At scale 1 with no scroll
    // the image point under the focus is image-x 100. At scale 2 that point
    // paints at 200, so the container must scroll to 200 - 100 = 100 to keep it
    // under the finger.
    expect(rescaleScroll(AT_TOP, { x: 100, y: 100 }, 1, 2)).toEqual({ left: 100, top: 100 });
  });

  it("compounds correctly from an already-scrolled, already-zoomed state", () => {
    // At scale 2 scrolled to 100, the focus at 100 holds image point
    // (100 + 100) / 2 = 100. Going to scale 4 puts it at 400 → scroll 300.
    expect(rescaleScroll({ left: 100, top: 100 }, { x: 100, y: 100 }, 2, 4)).toEqual({
      left: 300,
      top: 300,
    });
  });

  it("returns to zero scroll when zooming back out to fit", () => {
    // Whatever was held at 2x, at fit the image is smaller than the container
    // on both axes, so the arithmetic must not leave a positive offset behind.
    // (100 + 100)/2 * 1 - 100 = 0.
    expect(rescaleScroll({ left: 100, top: 100 }, { x: 100, y: 100 }, 2, 1)).toEqual({
      left: 0,
      top: 0,
    });
  });

  it("holds the top-left corner when the focus IS the top-left corner", () => {
    expect(rescaleScroll(AT_TOP, { x: 0, y: 0 }, 1, 3)).toEqual({ left: 0, top: 0 });
  });

  it("treats the two axes independently", () => {
    // A focus off-centre on x and at the corner on y must move x only.
    expect(rescaleScroll(AT_TOP, { x: 50, y: 0 }, 1, 2)).toEqual({ left: 50, top: 0 });
  });

  it("hands back an out-of-range offset rather than clamping it", () => {
    // The DOM clamps on assignment and is the only thing that knows the real
    // bounds; re-deriving them here is the duplicated geometry #1805 deleted.
    // Zooming OUT from a deep scroll legitimately computes a negative.
    const out = rescaleScroll({ left: 10, top: 10 }, { x: 500, y: 500 }, 4, 1);
    expect(out.left).toBeLessThan(0);
    expect(out.top).toBeLessThan(0);
  });

  it("is a no-op when the previous scale is zero (divide guard)", () => {
    const scroll: Scroll = { left: 7, top: 9 };
    expect(rescaleScroll(scroll, { x: 100, y: 100 }, 0, 2)).toEqual(scroll);
  });
});
