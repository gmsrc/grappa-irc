// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  bindDismissGesture,
  DISMISS_COMMIT_FRACTION,
  type DismissDirections,
  DRAGGING_CLASS,
} from "../lib/mediaViewerGesture";
import { fireTouch, fireTouchAt } from "./helpers/touchEvents";

// #1438 — a vertical drag on the media viewer dismisses it, and the modal
// follows the finger on the way. Composed from `lib/swipe.ts` (the #123
// geometry toolkit) and `lib/touchGesture.ts`'s angle gate rather than a second
// gesture engine, exactly as `bindMessageGestures` does — see the module.
//
// jsdom proves the DECISION path and the hard constraints: which drags commit,
// which spring back, that a horizontal drag is never claimed, that a zoomed
// image keeps its pan. It does NOT prove the feel, and it cannot prove the
// follow — a synthetic event drives no compositor. That half is vjt's
// on-device dogfood; see the spec header and the issue.

const VH = 800; // viewport height fed to the binder (jsdom has no layout)
const COMMIT_PX = VH * DISMISS_COMMIT_FRACTION;
const X = 200;
const START_Y = 400;

let modal: HTMLDivElement;
let media: HTMLImageElement;
let onProgress: Mock<(dy: number) => void>;
let onCommit: Mock<() => void>;
let onRelease: Mock<() => void>;
let canDismiss: Mock<() => boolean>;
let directions: DismissDirections;
let dispose: () => void;

function bind(): void {
  dispose = bindDismissGesture(modal, {
    viewportHeight: () => VH,
    canDismiss,
    directions,
    onProgress,
    onCommit,
    onRelease,
  });
}

beforeEach(() => {
  modal = document.createElement("div");
  modal.className = "media-viewer-modal";
  media = document.createElement("img");
  media.className = "media-viewer-media";
  modal.appendChild(media);
  document.body.appendChild(modal);
  onProgress = vi.fn<(dy: number) => void>();
  onCommit = vi.fn<() => void>();
  onRelease = vi.fn<() => void>();
  canDismiss = vi.fn<() => boolean>(() => true);
  directions = "both";
  bind();
});

afterEach(() => {
  dispose();
  document.body.innerHTML = "";
});

// A vertical drag of `dy` px (negative = up), in three steps so the binder can
// claim mid-drag — it claims late, never on touchstart. `elapsed` spaces the
// synthetic timeStamps so the velocity gate is exercised deliberately rather
// than by accident: jsdom stamps every synthetic event 0.
function dragVertically(
  target: HTMLElement,
  dy: number,
  elapsedMs: number,
): { moves: Event[]; end: Event } {
  fireTouchAt(target, "touchstart", 0, { clientX: X, clientY: START_Y });
  const moves = [
    fireTouchAt(target, "touchmove", elapsedMs / 3, { clientX: X, clientY: START_Y + dy / 3 }),
    fireTouchAt(target, "touchmove", (elapsedMs * 2) / 3, {
      clientX: X,
      clientY: START_Y + (dy * 2) / 3,
    }),
  ];
  const end = fireTouchAt(target, "touchend", elapsedMs, { clientX: X, clientY: START_Y + dy });
  return { moves, end };
}

describe("bindDismissGesture — commit vs spring back", () => {
  it("dismisses on a slow downward drag past the commit distance", () => {
    dragVertically(media, COMMIT_PX + 20, 2_000);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onRelease).not.toHaveBeenCalled();
  });

  it("dismisses on an upward drag too — both directions close", () => {
    dragVertically(media, -(COMMIT_PX + 20), 2_000);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("dismisses a short but FAST flick, below the commit distance", () => {
    dragVertically(media, 60, 100);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("springs back on a short slow drag — neither distance nor velocity", () => {
    dragVertically(media, 60, 2_000);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onRelease).toHaveBeenCalledTimes(1);
  });
});

describe("bindDismissGesture — following the finger", () => {
  it("reports the running delta mid-drag so the caller can move the modal", () => {
    dragVertically(media, 90, 2_000);
    expect(onProgress.mock.calls.map(([dy]) => dy)).toEqual([30, 60]);
  });

  it("marks the element as dragging so CSS can drop its snap-back transition", () => {
    fireTouch(media, "touchstart", { clientX: X, clientY: START_Y });
    expect(modal.classList.contains(DRAGGING_CLASS)).toBe(false); // not until claimed
    fireTouch(media, "touchmove", { clientX: X, clientY: START_Y + 40 });
    expect(modal.classList.contains(DRAGGING_CLASS)).toBe(true);
    fireTouch(media, "touchend", { clientX: X, clientY: START_Y + 40 });
    expect(modal.classList.contains(DRAGGING_CLASS)).toBe(false);
  });

  it("claims the gesture only once vertical intent is proven", () => {
    const { moves } = dragVertically(media, 90, 2_000);
    expect(moves.every((m) => m.defaultPrevented)).toBe(true);
  });
});

describe("bindDismissGesture — what it must NOT take", () => {
  it("leaves a horizontal-dominant drag entirely alone", () => {
    fireTouch(media, "touchstart", { clientX: X, clientY: START_Y });
    const move = fireTouch(media, "touchmove", { clientX: X + 90, clientY: START_Y + 10 });
    const end = fireTouch(media, "touchend", { clientX: X + 120, clientY: START_Y + 12 });
    expect(move.defaultPrevented).toBe(false);
    expect(end.defaultPrevented).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("stands down entirely when the caller says it cannot dismiss (zoomed image)", () => {
    canDismiss.mockReturnValue(false);
    const { moves } = dragVertically(media, COMMIT_PX + 20, 2_000);
    expect(moves.some((m) => m.defaultPrevented)).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("ignores a two-finger gesture — a pinch is the image's, not ours", () => {
    fireTouch(
      media,
      "touchstart",
      { clientX: X, clientY: START_Y },
      { clientX: X + 50, clientY: START_Y + 50 },
    );
    fireTouch(
      media,
      "touchmove",
      { clientX: X, clientY: START_Y + 200 },
      { clientX: X + 50, clientY: START_Y + 250 },
    );
    expect(onProgress).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("drops the gesture on touchcancel without dismissing", () => {
    fireTouch(media, "touchstart", { clientX: X, clientY: START_Y });
    fireTouch(media, "touchmove", { clientX: X, clientY: START_Y + COMMIT_PX + 20 });
    fireTouch(media, "touchcancel", { clientX: X, clientY: START_Y + COMMIT_PX + 20 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(modal.classList.contains(DRAGGING_CLASS)).toBe(false);
  });
});

describe("bindDismissGesture — lifecycle", () => {
  it("stops listening once disposed (Solid never re-invokes a ref at unmount)", () => {
    dispose();
    dragVertically(media, COMMIT_PX + 20, 2_000);
    expect(onCommit).not.toHaveBeenCalled();
    dispose = (): void => {}; // afterEach must not double-dispose
  });
});

// #1764 — a scrolling body (the .txt/.md source pane) cannot share the vertical
// axis with a gesture that commits in BOTH directions: at the top of the pane
// an upward drag means "read on", and dismissing there would take the primary
// interaction away. `directions: "down"` is that constraint, in the binder
// rather than in the caller, because the caller would have to re-derive the
// direction the binder already computes.
describe("bindDismissGesture — directions: 'down' (#1764)", () => {
  beforeEach(() => {
    directions = "down";
    dispose();
    bind();
  });

  it("a long downward drag still commits", () => {
    dragVertically(media, COMMIT_PX + 20, 2_000);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("a long UPWARD drag does not commit — and is not even claimed", () => {
    const { moves } = dragVertically(media, -(COMMIT_PX + 20), 2_000);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    // Unclaimed means the browser keeps the pan: the pane scrolls, which is
    // the whole reason the direction is narrowed. A claimed-then-refused drag
    // would have eaten the scroll and given nothing back.
    expect(moves.every((e) => !e.defaultPrevented)).toBe(true);
    expect(modal.classList.contains(DRAGGING_CLASS)).toBe(false);
  });

  it("an upward FLICK does not commit either — velocity is not a way around the direction", () => {
    dragVertically(media, -(COMMIT_PX + 20), 60);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
