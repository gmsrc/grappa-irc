// #1336 — the gesture is the instrument two scroll specs are judged by, so it
// has to be evidence rather than a hope. Runs under the cic vitest project
// (same reason, same shape as `whoisWait.test.ts`): the wait is deliberately
// free of Playwright, so it is provable without a testnet.
//
// The cases that matter are the ones the OLD idiom
// (`expect.poll(async () => { wheel(); return distance })`) got wrong:
// the wheel had not been applied yet when the predicate was read, and the
// predicate was ALREADY true of the pre-gesture state — measured on
// issue168-scroll-authority, where `scrollTop` was byte-identical (1078)
// before and after the "page up", and the scroll landed ~250 ms later,
// inside the next step.

import { describe, expect, it } from "vitest";
import { type ScrollPane, scrollByGesture } from "./scrollGesture";

type Recorded = { calls: string[]; pane: ScrollPane };

// A pane whose scrollTop walks the given script, one entry per read.
function fakePane(script: readonly number[]): Recorded {
  const calls: string[] = [];
  let reads = 0;
  return {
    calls,
    pane: {
      hover: async () => {
        calls.push("hover");
      },
      wheel: async (deltaY: number) => {
        calls.push(`wheel:${deltaY}`);
      },
      scrollTop: async () => {
        const value = script[Math.min(reads, script.length - 1)] ?? 0;
        reads += 1;
        calls.push(`read:${value}`);
        return value;
      },
    },
  };
}

async function failureOf(gesture: Promise<unknown>): Promise<string> {
  try {
    await gesture;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the gesture to reject, but it resolved");
}

describe("#1336 — scrollByGesture", () => {
  it("hovers BEFORE it wheels", async () => {
    const { calls, pane } = fakePane([1078, 500, 500]);
    await scrollByGesture(pane, { deltaY: -4000, timeoutMs: 1_000, pollMs: 1 });
    expect(calls.indexOf("hover")).toBeLessThan(calls.indexOf("wheel:-4000"));
  });

  it("returns the from/to pair once the scroll has moved and settled", async () => {
    const { pane } = fakePane([1078, 900, 800, 800]);
    const moved = await scrollByGesture(pane, { deltaY: -4000, timeoutMs: 1_000, pollMs: 1 });
    expect(moved).toEqual({ from: 1078, to: 800 });
  });

  it("does not return on a mid-flight sample — it waits for two that AGREE", async () => {
    // 900 and 800 are both mid-flight: the pane is still travelling and each
    // would report a position it is about to leave, which is the whole defect
    // being fixed. Only 700 repeats, so only 700 is a resting place. A
    // "return once it changed twice" implementation answers 800 here.
    const { pane } = fakePane([1078, 900, 800, 700, 700]);
    const moved = await scrollByGesture(pane, { deltaY: -4000, timeoutMs: 1_000, pollMs: 1 });
    expect(moved.to).toBe(700);
  });

  it("REJECTS when the wheel never moved the pane", async () => {
    // Measured: a wheel dispatched with the mouse elsewhere is inert and the
    // old idiom passed anyway, for a whole run.
    const { pane } = fakePane([1078]);
    expect(
      await failureOf(scrollByGesture(pane, { deltaY: -4000, timeoutMs: 20, pollMs: 1 })),
    ).toContain("never moved");
  });

  it("REJECTS when the pane is still moving at the deadline", async () => {
    let value = 1078;
    const pane: ScrollPane = {
      hover: async () => {},
      wheel: async () => {},
      scrollTop: async () => {
        value -= 10;
        return value;
      },
    };
    expect(
      await failureOf(scrollByGesture(pane, { deltaY: -4000, timeoutMs: 20, pollMs: 1 })),
    ).toContain("never settled");
  });
});
