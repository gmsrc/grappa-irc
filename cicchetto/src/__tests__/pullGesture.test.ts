// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { bindPullGesture, PULL_COMMIT_PX, PULLING_CLASS } from "../lib/pullGesture";
import { SWIPE_MIN_PX } from "../lib/swipe";
import { fireTouch } from "./helpers/touchEvents";

// #1445 — pull down from the top of a scroller to ask for a refresh.
//
// WHAT THIS PROVES: the DECISION table. Which drags commit, which spring back,
// which are never claimed at all, and that the arming condition is re-read
// mid-drag rather than snapshotted.
//
// WHAT IT CANNOT PROVE, and this is half the value of saying so: jsdom sees
// neither `touch-action` nor Solid's passive event delegation (#308 landmine
// 1), and a synthetic event drives no compositor. So nothing here says the
// follow is smooth, that `PULL_COMMIT_PX` is the right distance, or that iOS
// Safari's own rubber-band at the top of a scroller leaves the transform
// alone. Those are e2e and on-device questions; the pane wiring and the CSS
// contract land with the slice that paints the thing.

const X = 200;
const START_Y = 300;

// A travel that clears the bare swipe floor but NOT the pull's commit
// distance. Derived from BOTH constants on purpose: a magnitude written as
// `PULL_COMMIT_PX - 20` is invisible to the value of PULL_COMMIT_PX — halve
// the constant and the drag shrinks with it, staying under the floor and
// passing anyway. Measured: a mutant dropping PULL_COMMIT_PX to SWIPE_MIN_PX
// survived the whole suite until this was anchored between the two.
const BETWEEN_FLOOR_AND_COMMIT = (SWIPE_MIN_PX + PULL_COMMIT_PX) / 2;

let list: HTMLDivElement;
let row: HTMLDivElement;
let canPull: Mock<() => boolean>;
let onProgress: Mock<(dy: number) => void>;
let onCommit: Mock<() => void>;
let onRelease: Mock<() => void>;
let dispose: () => void;

beforeEach(() => {
  list = document.createElement("div");
  row = document.createElement("div");
  list.appendChild(row);
  document.body.appendChild(list);
  canPull = vi.fn<() => boolean>(() => true);
  onProgress = vi.fn<(dy: number) => void>();
  onCommit = vi.fn<() => void>();
  onRelease = vi.fn<() => void>();
  dispose = bindPullGesture(list, { canPull, onProgress, onCommit, onRelease });
});

afterEach(() => {
  dispose();
  document.body.innerHTML = "";
});

// A vertical drag of `dy` px (negative = up) in three steps: the binder claims
// LATE, on a touchmove, never on the touchstart. Fired on the ROW so the event
// reaches the bound container by bubbling, as it does in a browser.
function drag(dy: number): { moves: Event[]; end: Event } {
  fireTouch(row, "touchstart", { clientX: X, clientY: START_Y });
  const moves = [
    fireTouch(row, "touchmove", { clientX: X, clientY: START_Y + dy / 3 }),
    fireTouch(row, "touchmove", { clientX: X, clientY: START_Y + (dy * 2) / 3 }),
  ];
  const end = fireTouch(row, "touchend", { clientX: X, clientY: START_Y + dy });
  return { moves, end };
}

describe("bindPullGesture — commit vs spring back", () => {
  it("commits a downward pull past the commit distance", () => {
    drag(PULL_COMMIT_PX + 20);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onRelease).not.toHaveBeenCalled();
  });

  it("springs back between the swipe floor and the commit distance, however fast", () => {
    // Past the 8px slop and past the 40px swipe floor, so this is a CLAIMED
    // pull that simply did not go far enough — not an unclaimed drag. That is
    // what makes the commit distance the thing under test: relax it to the
    // bare floor and this drag commits.
    //
    // It also guards the deliberate divergence from the viewer's dismiss,
    // which commits on velocity as well as distance. jsdom stamps every
    // synthetic event 0, so this drag is INSTANTANEOUS: any velocity route
    // would read it as a flick and commit. One gesture, one mutant, both
    // claims — a separate "flick" test would be the same drag asserting the
    // same thing twice.
    drag(BETWEEN_FLOOR_AND_COMMIT);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onRelease).toHaveBeenCalledTimes(1);
  });
});

describe("bindPullGesture — following the finger", () => {
  it("reports the running downward travel so the caller can move its slot", () => {
    drag(90);
    expect(onProgress.mock.calls.map(([dy]) => dy)).toEqual([30, 60]);
  });

  it("floors the reported travel at 0 when the finger goes back above its origin", () => {
    fireTouch(row, "touchstart", { clientX: X, clientY: START_Y });
    fireTouch(row, "touchmove", { clientX: X, clientY: START_Y + 60 }); // claim
    fireTouch(row, "touchmove", { clientX: X, clientY: START_Y - 40 }); // back up past it
    expect(onProgress.mock.calls.map(([dy]) => dy)).toEqual([60, 0]);
  });

  it("wears the pulling class for exactly the claimed part of the touch", () => {
    fireTouch(row, "touchstart", { clientX: X, clientY: START_Y });
    expect(list.classList.contains(PULLING_CLASS)).toBe(false); // not until claimed
    fireTouch(row, "touchmove", { clientX: X, clientY: START_Y + 60 });
    expect(list.classList.contains(PULLING_CLASS)).toBe(true);
    fireTouch(row, "touchend", { clientX: X, clientY: START_Y + 60 });
    expect(list.classList.contains(PULLING_CLASS)).toBe(false);
  });

  it("claims the gesture once downward intent is proven", () => {
    const { moves } = drag(90);
    expect(moves.every((m) => m.defaultPrevented)).toBe(true);
  });
});

describe("bindPullGesture — what it must NOT take", () => {
  it("leaves an UPWARD drag entirely alone — native scroll is untouched", () => {
    // The hard constraint. `verticalClaim` is direction-agnostic, so nothing
    // but the explicit downward gate keeps this drag out of our hands, and
    // taking it would preventDefault ordinary list scrolling.
    const { moves, end } = drag(-120);
    expect(moves.some((m) => m.defaultPrevented)).toBe(false);
    expect(end.defaultPrevented).toBe(false);
    expect(onProgress).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onRelease).not.toHaveBeenCalled();
  });

  it("leaves a horizontal-dominant drag alone", () => {
    fireTouch(row, "touchstart", { clientX: X, clientY: START_Y });
    const move = fireTouch(row, "touchmove", { clientX: X + 120, clientY: START_Y + 20 });
    fireTouch(row, "touchend", { clientX: X + 140, clientY: START_Y + 24 });
    expect(move.defaultPrevented).toBe(false);
    expect(onProgress).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("stands down when the caller says it cannot pull (list not at the top)", () => {
    canPull.mockReturnValue(false);
    const { moves } = drag(PULL_COMMIT_PX + 20);
    expect(moves.some((m) => m.defaultPrevented)).toBe(false);
    expect(onProgress).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("re-reads canPull mid-drag instead of snapshotting it at touchstart", () => {
    // Before the claim, native scroll is still running: a finger can drag UP,
    // carry the list away from the top, then come back DOWN. A touchstart
    // snapshot would claim that reversal as a pull on a list scrolled well
    // past 0. Arming true at touchstart and false by the time the downward
    // move arrives is exactly that shape.
    fireTouch(row, "touchstart", { clientX: X, clientY: START_Y });
    canPull.mockReturnValue(false);
    const move = fireTouch(row, "touchmove", { clientX: X, clientY: START_Y + 90 });
    expect(move.defaultPrevented).toBe(false);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("ignores a two-finger gesture — a pinch belongs to the content", () => {
    fireTouch(
      row,
      "touchstart",
      { clientX: X, clientY: START_Y },
      { clientX: X + 40, clientY: START_Y + 40 },
    );
    fireTouch(
      row,
      "touchmove",
      { clientX: X, clientY: START_Y + 200 },
      { clientX: X + 40, clientY: START_Y + 240 },
    );
    expect(onProgress).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("drops a claimed pull on touchcancel without committing", () => {
    fireTouch(row, "touchstart", { clientX: X, clientY: START_Y });
    fireTouch(row, "touchmove", { clientX: X, clientY: START_Y + PULL_COMMIT_PX + 20 });
    fireTouch(row, "touchcancel", { clientX: X, clientY: START_Y + PULL_COMMIT_PX + 20 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(list.classList.contains(PULLING_CLASS)).toBe(false);
  });

  it("says nothing on a touchcancel that never claimed", () => {
    fireTouch(row, "touchstart", { clientX: X, clientY: START_Y });
    fireTouch(row, "touchcancel", { clientX: X, clientY: START_Y });
    expect(onRelease).not.toHaveBeenCalled();
  });
});

describe("bindPullGesture — lifecycle", () => {
  it("stops listening once disposed (Solid never re-invokes a ref at unmount)", () => {
    dispose();
    drag(PULL_COMMIT_PX + 20);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    dispose = (): void => {}; // afterEach must not double-dispose
  });
});
