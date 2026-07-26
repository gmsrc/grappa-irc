import { describe, expect, it } from "vitest";
import { ANGLE_GATE_K, EDGE_ZONE_PX, horizontalClaim, touchZone } from "../lib/touchGesture";

// #308 INC-A — mobile touch gestures, pure geometry. DOM-free so it unit-tests
// without touch physics (Playwright webkit ≠ iOS scroll; the *feel* is verified
// on-device post-deploy — the wiring + hard constraints are e2e/vitest here).
// A point is {x, y} in client px; screen y grows DOWNWARD; viewport width in px.

describe("touchZone", () => {
  const W = 400; // viewport width

  it("classifies a touch at the extreme right as the right edge", () => {
    expect(touchZone(W - 1, W)).toBe("right-edge");
  });

  it("classifies a touch at the extreme left as the left edge", () => {
    expect(touchZone(0, W)).toBe("left-edge");
  });

  it("classifies a touch in the middle as the center", () => {
    expect(touchZone(W / 2, W)).toBe("center");
  });

  it("treats exactly EDGE_ZONE_PX from the left as still the left edge", () => {
    expect(touchZone(EDGE_ZONE_PX, W)).toBe("left-edge");
  });

  it("treats exactly EDGE_ZONE_PX from the right as still the right edge", () => {
    expect(touchZone(W - EDGE_ZONE_PX, W)).toBe("right-edge");
  });

  it("treats one px inside the edge zone as the center", () => {
    expect(touchZone(EDGE_ZONE_PX + 1, W)).toBe("center");
    expect(touchZone(W - EDGE_ZONE_PX - 1, W)).toBe("center");
  });

  it("honors a caller-supplied edge width", () => {
    expect(touchZone(30, 400, 40)).toBe("left-edge");
    expect(touchZone(30, 400, 20)).toBe("center");
  });
});

describe("horizontalClaim — the vertical-scroll protector (hard constraint)", () => {
  const START = { x: 200, y: 300 };

  it("claims a clearly horizontal drag", () => {
    expect(horizontalClaim(START, { x: 160, y: 302 })).toBe(true);
  });

  // THE hard-constraint assertion: a vertical-dominant drag is NEVER claimed,
  // so the directive never preventDefaults it and native vertical scroll is
  // byte-for-byte untouched. This is asserted, not hoped.
  it("NEVER claims a vertical-dominant drag (native scroll must survive)", () => {
    expect(horizontalClaim(START, { x: 205, y: 360 })).toBe(false); // finger down
    expect(horizontalClaim(START, { x: 195, y: 240 })).toBe(false); // finger up
    expect(horizontalClaim(START, { x: 200, y: 400 })).toBe(false); // pure vertical
  });

  it("does not claim a diagonal that fails the angle gate |dx| >= |dy|*k", () => {
    // dx=30, dy=30 → 30 >= 30*1.5 is false → not horizontal enough
    expect(horizontalClaim(START, { x: 230, y: 330 })).toBe(false);
  });

  it("claims a diagonal that clears the angle gate", () => {
    // dx=60, dy=20 → 60 >= 20*1.5 (=30) → horizontal-dominant
    expect(horizontalClaim(START, { x: 260, y: 320 })).toBe(true);
  });

  it("does not claim travel under the slop (still undecided)", () => {
    expect(horizontalClaim(START, { x: 205, y: 300 })).toBe(false);
  });

  it("honors a caller-supplied angle factor and slop", () => {
    // dx=40, dy=25 → passes at k=1.5 (40>=37.5), fails at k=2 (40>=50 false)
    expect(horizontalClaim(START, { x: 240, y: 325 }, 1.5)).toBe(true);
    expect(horizontalClaim(START, { x: 240, y: 325 }, 2)).toBe(false);
  });

  it("exposes a sane default angle factor", () => {
    expect(ANGLE_GATE_K).toBeGreaterThanOrEqual(1.5);
  });
});
