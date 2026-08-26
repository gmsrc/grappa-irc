import { describe, expect, it } from "vitest";
import { ADM_RAIN_LOOK } from "../AdminDebugTab";
import {
  CREDITS_RAIN_BURST_LOOK,
  CREDITS_RAIN_LOOK,
  creditsRainLook,
  rollIsParked,
} from "../lib/creditsRain";
import { ruleBody, themeCss } from "./helpers/themeCss";

// #1807 — the credits rain reads as rain, and the burst rides the roll's own
// clock.
//
// Two subjects, and they are one subject: the LOOKS are only correct relative
// to what the Debug panel still runs (the issue's "0.7x the current speed"
// names that surface's speed), and the interlude only exists because the
// stylesheet parks the roll before its cycle ends. So the numbers are checked
// against the other surface's constant and against the stylesheet, never
// against a copy of themselves.
//
// What is NOT provable here: jsdom runs no animation, so the phase reader is
// exercised against a fake `getAnimations`. That the REAL CSS animation
// exposes the offsets this depends on is the e2e's job
// (issue1807-credits-rain-reads-as-rain.spec.ts) — and that the result looks
// like rain to a human is nobody's job but a human's, on a real phone.

type FakeStop = { readonly computedOffset: number; readonly transform: string };

/**
 * An element that answers `getAnimations()` the way a browser running
 * `credits-roll` would. Only that one method is reached, so the cast is the
 * whole of the fake.
 */
function fakeRoll(progress: number | null, stops: readonly FakeStop[]): HTMLElement {
  return {
    getAnimations: () => [
      {
        effect: {
          getComputedTiming: () => ({ progress }),
          getKeyframes: () => stops,
        },
      },
    ],
  } as unknown as HTMLElement;
}

const TRAVELLING = "translateY(100%)";
const PARKED = "translateY(-100%)";
const PARKS_AT_082: readonly FakeStop[] = [
  { computedOffset: 0, transform: TRAVELLING },
  { computedOffset: 0.82, transform: PARKED },
  { computedOffset: 1, transform: PARKED },
];

describe("credits rain look (#1807)", () => {
  it("is louder than the panel the effect was tuned for, on every knob", () => {
    // The defect was that the credits rain read as a faint texture. Each
    // comparison names the axis it fixes, against the surface whose settings
    // it inherited.
    expect(CREDITS_RAIN_LOOK.glyphAlpha).toBeGreaterThan(ADM_RAIN_LOOK.glyphAlpha);
    expect(CREDITS_RAIN_LOOK.fadeAlpha).toBeLessThan(ADM_RAIN_LOOK.fadeAlpha);
    expect(CREDITS_RAIN_LOOK.leader).not.toBeNull();
    // vjt asked for 0.7x THE CURRENT SPEED, and the current speed is the one
    // the Debug panel still runs at.
    expect(CREDITS_RAIN_LOOK.rowsPerFrame).toBeCloseTo(0.7 * ADM_RAIN_LOOK.rowsPerFrame, 10);
  });

  it("bursts louder still, and faster than its own baseline", () => {
    expect(CREDITS_RAIN_BURST_LOOK.leader).toBe("rgba(255, 255, 255, 1)");
    expect(CREDITS_RAIN_BURST_LOOK.glyphAlpha).toBeGreaterThan(CREDITS_RAIN_LOOK.glyphAlpha);
    expect(CREDITS_RAIN_BURST_LOOK.fadeAlpha).toBeLessThan(CREDITS_RAIN_LOOK.fadeAlpha);
    expect(CREDITS_RAIN_BURST_LOOK.rowsPerFrame).toBeGreaterThan(CREDITS_RAIN_LOOK.rowsPerFrame);
  });

  it("stays on the steady look while the titles are travelling", () => {
    expect(creditsRainLook(fakeRoll(0, PARKS_AT_082))).toBe(CREDITS_RAIN_LOOK);
    expect(creditsRainLook(fakeRoll(0.5, PARKS_AT_082))).toBe(CREDITS_RAIN_LOOK);
    expect(creditsRainLook(fakeRoll(0.8199, PARKS_AT_082))).toBe(CREDITS_RAIN_LOOK);
  });

  it("bursts for exactly the stretch the roll spends parked", () => {
    // The boundary belongs to the interlude: the instant the translate stops
    // moving there is nothing on screen but rain.
    expect(creditsRainLook(fakeRoll(0.82, PARKS_AT_082))).toBe(CREDITS_RAIN_BURST_LOOK);
    expect(creditsRainLook(fakeRoll(0.99, PARKS_AT_082))).toBe(CREDITS_RAIN_BURST_LOOK);
  });

  it("takes the park offset from the keyframes rather than from a constant", () => {
    // Retime the roll and the burst follows, with nothing in TS to edit. A
    // hardcoded 0.82 would keep bursting at 0.82 of a cycle that now parks
    // somewhere else, which is the drift this reader exists to avoid.
    const parksLate: readonly FakeStop[] = [
      { computedOffset: 0, transform: TRAVELLING },
      { computedOffset: 0.95, transform: PARKED },
      { computedOffset: 1, transform: PARKED },
    ];
    expect(creditsRainLook(fakeRoll(0.9, parksLate))).toBe(CREDITS_RAIN_LOOK);
    expect(creditsRainLook(fakeRoll(0.96, parksLate))).toBe(CREDITS_RAIN_BURST_LOOK);
  });

  it("never bursts when there is no interlude to be inside of", () => {
    // #1773's seamless two-stop roll. Reintroduce it and the burst must go
    // away with the hold, not fire against a moving title.
    const seamless: readonly FakeStop[] = [
      { computedOffset: 0, transform: TRAVELLING },
      { computedOffset: 1, transform: PARKED },
    ];
    expect(rollIsParked(fakeRoll(0.999, seamless))).toBe(false);
  });

  it("degrades to the steady look when there is no animation to read", () => {
    // Three real cases, one answer: before the roll mounts, under
    // `prefers-reduced-motion` (where the roll is a plain scrollable column),
    // and in jsdom. None of them is an error, and none of them may throw.
    expect(creditsRainLook(undefined)).toBe(CREDITS_RAIN_LOOK);
    expect(creditsRainLook({ getAnimations: () => [] } as unknown as HTMLElement)).toBe(
      CREDITS_RAIN_LOOK,
    );
    expect(creditsRainLook(document.createElement("div"))).toBe(CREDITS_RAIN_LOOK);
    expect(creditsRainLook(fakeRoll(null, PARKS_AT_082))).toBe(CREDITS_RAIN_LOOK);
  });
});

describe("credits roll timing (#1807 — the stylesheet owns the interlude)", () => {
  const cycleSeconds = (): number => {
    const declared = /animation:\s*credits-roll\s+([\d.]+)s/.exec(ruleBody(".credits-roll"));
    const seconds = Number(declared?.[1]);
    expect(Number.isFinite(seconds)).toBe(true);
    return seconds;
  };

  /** The `@keyframes credits-roll` stops, as `{ at, transform }`. The block
      has nested braces, so it is matched up to the first `}` at column 0. */
  const stops = (): { at: number; transform: string }[] => {
    const block = /@keyframes credits-roll\s*\{([\s\S]*?)\n\}/.exec(themeCss)?.[1];
    expect(block, "@keyframes credits-roll not found in default.css").toBeDefined();
    const parsed = [...(block ?? "").matchAll(/(\d+)%\s*\{\s*transform:\s*([^;]+);/g)].map((m) => ({
      at: Number(m[1]) / 100,
      transform: (m[2] ?? "").trim(),
    }));
    expect(parsed.length).toBeGreaterThanOrEqual(2);
    return parsed;
  };

  it("parks the roll off the top for the 5-7s of pure rain the issue asked for", () => {
    const all = stops();
    const last = all.at(-1);
    expect(last?.at).toBe(1);

    // The hold starts at the FIRST stop already carrying the final transform.
    const park = all.find((stop) => stop.transform === last?.transform);
    expect(park?.at, "the last two stops must share a transform, or there is no hold").toBeLessThan(
      1,
    );

    const interlude = cycleSeconds() * (1 - (park?.at ?? 1));
    expect(interlude).toBeGreaterThanOrEqual(5);
    expect(interlude).toBeLessThanOrEqual(7);
  });

  it("holds it OFF-SCREEN, and re-enters from the bottom", () => {
    // Not a pause mid-list: the parked transform is the one that has the roll
    // fully above the fold, and the cycle restarts from fully below it — the
    // same entrance as the first pass.
    const all = stops();
    expect(all[0]?.transform).toBe("translateY(100%)");
    expect(all.at(-1)?.transform).toBe("translateY(-100%)");
  });

  it("did not slow the titles down to buy the interlude", () => {
    // #1773 rolled the whole 28s cycle. The interlude is bought by a LONGER
    // cycle, so the travel — and therefore how long a reader has to read each
    // name — is where it was.
    const all = stops();
    const park = all.find((stop) => stop.transform === all.at(-1)?.transform);
    expect(cycleSeconds() * (park?.at ?? 1)).toBeCloseTo(28, 0);
  });
});
