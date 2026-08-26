import { describe, expect, it } from "vitest";
import { ADM_RAIN_LOOK } from "../AdminDebugTab";
import { CREDITS_RAIN_LOOK } from "../lib/creditsRain";

// #1807 — the credits rain reads as rain.
//
// The numbers are only correct RELATIVE to the surface they were inherited
// from: the issue's "0.7x the current speed" names the Debug panel's speed,
// and every other knob is a complaint about that panel's settings behind the
// end titles. So each assertion compares against the other surface's constant
// rather than against a copy of itself, which a `toEqual` on a literal would
// be.

describe("credits rain look (#1807)", () => {
  it("is louder than the panel the effect was tuned for, on every knob", () => {
    // The defect was that the credits rain read as a faint texture. Each
    // comparison names the axis it fixes.
    expect(CREDITS_RAIN_LOOK.glyphAlpha).toBeGreaterThan(ADM_RAIN_LOOK.glyphAlpha);
    expect(CREDITS_RAIN_LOOK.fadeAlpha).toBeLessThan(ADM_RAIN_LOOK.fadeAlpha);
    expect(CREDITS_RAIN_LOOK.leader).not.toBeNull();
    // vjt asked for 0.7x THE CURRENT SPEED, and the current speed is the one
    // the Debug panel still runs at.
    expect(CREDITS_RAIN_LOOK.rowsPerFrame).toBeCloseTo(0.7 * ADM_RAIN_LOOK.rowsPerFrame, 10);
  });
});
