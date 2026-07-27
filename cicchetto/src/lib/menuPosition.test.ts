import { describe, expect, it } from "vitest";
import { computeMenuPosition, placeAxis } from "./menuPosition";

// #487 — the member-list right-click context menu must stay inside the
// viewport. The positioning math is a PURE fn so the arithmetic is
// unit-testable without a real viewport (jsdom's getBoundingClientRect
// returns 0-sized rects — a jsdom placement test would be hollow). The
// real-viewport proof lives in the Playwright e2e
// (issue487-context-menu-viewport-clamp.spec.ts); these tests pin the
// flip/clamp arithmetic.
//
// placeAxis is the 1D primitive applied independently to X and Y:
//   * fits after the click         → keep the click coord (open down/right)
//   * overflows the far edge        → FLIP before the click (open up/left,
//                                     pointer stays on the menu edge)
//   * flip would underflow origin   → CLAMP to the last fully-visible coord
//   * menu bigger than the viewport → pin to 0 (CSS max-height + scroll)

describe("placeAxis (1D flip/clamp primitive)", () => {
  it("keeps the click coord when the menu fits after it", () => {
    expect(placeAxis(100, 120, 1000)).toBe(100);
  });

  it("flips before the click point when the menu overflows the far edge", () => {
    // click 950, menu 120, viewport 1000 → 1070 > 1000 → flip: 950 - 120
    expect(placeAxis(950, 120, 1000)).toBe(830);
  });

  it("keeps a click that lands exactly at the far edge", () => {
    // click 880, menu 120, viewport 1000 → 880 + 120 == 1000 → fits, no flip
    expect(placeAxis(880, 120, 1000)).toBe(880);
  });

  it("clamps to fully-visible when a flip would underflow the origin", () => {
    // click 100, menu 180, viewport 200 → overflow (280>200) AND menu fits
    // (180<200); flip 100-180=-80 < 0 → clamp to viewport-size = 20
    expect(placeAxis(100, 180, 200)).toBe(20);
  });

  it("pins to the edge when the menu is taller/wider than the viewport", () => {
    expect(placeAxis(150, 300, 200)).toBe(0);
    expect(placeAxis(150, 200, 200)).toBe(0); // equal counts as oversized
  });
});

describe("computeMenuPosition (both axes)", () => {
  it("passes through when the menu fits below-and-right of the click", () => {
    expect(
      computeMenuPosition({
        clickX: 100,
        clickY: 200,
        menuWidth: 120,
        menuHeight: 200,
        viewportWidth: 1280,
        viewportHeight: 720,
      }),
    ).toEqual({ left: 100, top: 200 });
  });

  it("flips up when the menu would overflow the bottom (the #487 report)", () => {
    const p = computeMenuPosition({
      clickX: 100,
      clickY: 700,
      menuWidth: 120,
      menuHeight: 200,
      viewportWidth: 1280,
      viewportHeight: 720,
    });
    expect(p.top).toBe(500); // 700 - 200
    expect(p.left).toBe(100); // X fits — unchanged
  });

  it("flips left when the menu would overflow the right edge (members rail)", () => {
    const p = computeMenuPosition({
      clickX: 1270,
      clickY: 100,
      menuWidth: 120,
      menuHeight: 200,
      viewportWidth: 1280,
      viewportHeight: 720,
    });
    expect(p.left).toBe(1150); // 1270 - 120
    expect(p.top).toBe(100);
  });

  it("flips both axes for a bottom-right corner click", () => {
    expect(
      computeMenuPosition({
        clickX: 1276,
        clickY: 716,
        menuWidth: 120,
        menuHeight: 200,
        viewportWidth: 1280,
        viewportHeight: 720,
      }),
    ).toEqual({ left: 1156, top: 516 });
  });

  it("pins to the top when the menu is taller than a short viewport", () => {
    // mobile keyboard up → --viewport-height ~180, menu ~200 → top 0 + scroll
    const p = computeMenuPosition({
      clickX: 100,
      clickY: 150,
      menuWidth: 120,
      menuHeight: 200,
      viewportWidth: 390,
      viewportHeight: 180,
    });
    expect(p.top).toBe(0);
  });
});
