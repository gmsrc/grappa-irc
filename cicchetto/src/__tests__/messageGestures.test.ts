// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { LONG_PRESS_MS } from "../lib/keepKeyboard";
import {
  bindMessageGestures,
  HOLD_MOVE_TOLERANCE_PX,
  SWIPE_MAX_SLIDE_PX,
  SWIPING_CLASS,
} from "../lib/messageGestures";
import { fireTouch } from "./helpers/touchEvents";

// #1067 — the scrollback's ONE touch-gesture owner: a left→right swipe on a
// message row fills the compose box with a quote, a stationary hold opens the
// message menu. Both read the SAME touchstart→move→end stream, which is why
// they live in one binder: two independent binders would each keep their own
// "did it move" state and could fire together on one gesture.
//
// jsdom proves the DECISION path and the hard constraints (a vertical drag is
// never claimed; the left edge is left to #1041's sidebar; an inline control
// never arms). It does NOT prove the feel — synthetic events drive no pixel
// scroll and jsdom is not iOS. That part is vjt's on-device dogfood.

const W = 390; // viewport width fed to the binder (jsdom has no layout)
const CENTER_X = 200; // outside both 20px edge zones

let pane: HTMLDivElement;
let row: HTMLDivElement;
let body: HTMLSpanElement;
let link: HTMLAnchorElement;
let onReply: Mock<(row: HTMLElement) => void>;
let onLongPress: Mock<(row: HTMLElement, at: { x: number; y: number }) => void>;
let dispose: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  pane = document.createElement("div");
  pane.className = "scrollback";
  row = document.createElement("div");
  row.className = "scrollback-line";
  body = document.createElement("span");
  body.className = "scrollback-body";
  link = document.createElement("a");
  link.className = "scrollback-link";
  row.append(body, link);
  pane.appendChild(row);
  document.body.appendChild(pane);
  onReply = vi.fn<(row: HTMLElement) => void>();
  onLongPress = vi.fn<(row: HTMLElement, at: { x: number; y: number }) => void>();
  dispose = bindMessageGestures(pane, { viewportWidth: () => W, onReply, onLongPress });
});

afterEach(() => {
  dispose();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

// A left→right drag across `dx` px, starting at CENTER_X on `target`.
function swipeRight(target: HTMLElement, dx: number): { moves: Event[]; end: Event } {
  fireTouch(target, "touchstart", { clientX: CENTER_X, clientY: 300 });
  const moves = [
    fireTouch(target, "touchmove", { clientX: CENTER_X + dx / 3, clientY: 303 }),
    fireTouch(target, "touchmove", { clientX: CENTER_X + (dx * 2) / 3, clientY: 305 }),
  ];
  const end = fireTouch(target, "touchend", { clientX: CENTER_X + dx, clientY: 306 });
  return { moves, end };
}

describe("bindMessageGestures — swipe left→right = reply", () => {
  it("fires onReply with the message row for a right swipe past the floor", () => {
    swipeRight(body, 90);
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply.mock.calls[0]?.[0]).toBe(row);
  });

  it("claims the gesture (preventDefault) only once horizontal intent is proven", () => {
    const { moves } = swipeRight(body, 90);
    expect(moves.every((m) => m.defaultPrevented)).toBe(true);
  });

  it("slides the row with the finger, capped, and snaps it back on release", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    fireTouch(body, "touchmove", { clientX: CENTER_X + 40, clientY: 302 });
    expect(row.style.transform).toBe("translateX(40px)");
    expect(row.classList.contains(SWIPING_CLASS)).toBe(true);
    // Past the cap the row stops following — the finger keeps going.
    fireTouch(body, "touchmove", { clientX: CENTER_X + SWIPE_MAX_SLIDE_PX + 60, clientY: 302 });
    expect(row.style.transform).toBe(`translateX(${SWIPE_MAX_SLIDE_PX}px)`);
    fireTouch(body, "touchend", { clientX: CENTER_X + SWIPE_MAX_SLIDE_PX + 60, clientY: 302 });
    // Snap back: the inline transform is dropped so the CSS transition runs.
    expect(row.style.transform).toBe("");
    expect(row.classList.contains(SWIPING_CLASS)).toBe(false);
  });

  it("snaps the row back on touchcancel without replying", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    fireTouch(body, "touchmove", { clientX: CENTER_X + 90, clientY: 302 });
    fireTouch(body, "touchcancel", { clientX: CENTER_X + 90, clientY: 302 });
    expect(row.style.transform).toBe("");
    expect(onReply).not.toHaveBeenCalled();
  });

  it("does NOT reply on a right drag that stays under the 40px floor", () => {
    swipeRight(body, 24);
    expect(onReply).not.toHaveBeenCalled();
  });

  // The hard constraint, inherited from #308: a vertical drag is never claimed,
  // so native scroll through the scrollback is byte-for-byte untouched.
  it("NEVER claims a vertical drag (scrollback scroll survives)", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 200 });
    const m1 = fireTouch(body, "touchmove", { clientX: CENTER_X + 3, clientY: 300 });
    const m2 = fireTouch(body, "touchmove", { clientX: CENTER_X + 6, clientY: 420 });
    fireTouch(body, "touchend", { clientX: CENTER_X + 6, clientY: 480 });
    expect(m1.defaultPrevented).toBe(false);
    expect(m2.defaultPrevented).toBe(false);
    expect(onReply).not.toHaveBeenCalled();
    expect(row.style.transform).toBe("");
  });

  // dx→sx is explicitly NOT decided (#1067: "vabe vediamo come viene"). We must
  // not eat the gesture: no claim, no slide, no callback.
  it("leaves a right→left drag entirely alone (that direction is unspecified)", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    const m = fireTouch(body, "touchmove", { clientX: CENTER_X - 90, clientY: 302 });
    fireTouch(body, "touchend", { clientX: CENTER_X - 120, clientY: 303 });
    expect(m.defaultPrevented).toBe(false);
    expect(row.style.transform).toBe("");
    expect(onReply).not.toHaveBeenCalled();
  });

  // #1041 owns the left edge: a right swipe there opens the channel sidebar.
  // Zone separation is what keeps the two gestures from both firing.
  it("never arms in the left edge zone (#1041's sidebar swipe wins)", () => {
    fireTouch(body, "touchstart", { clientX: 5, clientY: 300 });
    const m = fireTouch(body, "touchmove", { clientX: 100, clientY: 303 });
    fireTouch(body, "touchend", { clientX: 190, clientY: 305 });
    expect(m.defaultPrevented).toBe(false);
    expect(onReply).not.toHaveBeenCalled();
  });

  it("never arms on an inline control inside the row (link keeps its own gesture)", () => {
    swipeRight(link, 90);
    expect(onReply).not.toHaveBeenCalled();
    expect(row.style.transform).toBe("");
  });

  it("never arms outside a message row", () => {
    const stray = document.createElement("div");
    pane.appendChild(stray);
    swipeRight(stray, 90);
    expect(onReply).not.toHaveBeenCalled();
  });

  it("ignores a multi-touch gesture (a pinch is not a swipe)", () => {
    fireTouch(
      body,
      "touchstart",
      { clientX: CENTER_X, clientY: 300 },
      { clientX: CENTER_X + 50, clientY: 300 },
    );
    const m = fireTouch(
      body,
      "touchmove",
      { clientX: CENTER_X + 90, clientY: 302 },
      { clientX: CENTER_X + 140, clientY: 302 },
    );
    fireTouch(body, "touchend", { clientX: CENTER_X + 90, clientY: 302 });
    expect(m.defaultPrevented).toBe(false);
    expect(onReply).not.toHaveBeenCalled();
  });
});

describe("bindMessageGestures — long press = message menu", () => {
  it("opens the menu for the row after the hold threshold, at the touch point", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress.mock.calls[0]?.[0]).toBe(row);
    expect(onLongPress.mock.calls[0]?.[1]).toEqual({ x: CENTER_X, y: 300 });
  });

  // The whole point of the #1067 pivot away from #366: the menu behaves the
  // same whether or not the compose box has focus. No keyboard gate.
  it("opens with the compose box focused too (no keyboard-up gate)", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("does not open on a short tap", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS - 50);
    fireTouch(body, "touchend", { clientX: CENTER_X, clientY: 300 });
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels the hold once the finger moves past the tolerance (a scroll)", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    fireTouch(body, "touchmove", {
      clientX: CENTER_X,
      clientY: 300 + HOLD_MOVE_TOLERANCE_PX + 5,
    });
    vi.advanceTimersByTime(LONG_PRESS_MS + 100);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("survives a jitter under the tolerance", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    fireTouch(body, "touchmove", { clientX: CENTER_X + 2, clientY: 303 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  // Once the menu is up the finger release must not ALSO fire a reply, and it
  // must not synthesize the click that would immediately close the menu on its
  // own backdrop — preventing the touchend is the spec-blessed way to say so.
  it("suppresses the release after a hold: no reply, and the tap is cancelled", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    const end = fireTouch(body, "touchend", { clientX: CENTER_X, clientY: 300 });
    expect(onReply).not.toHaveBeenCalled();
    expect(end.defaultPrevented).toBe(true);
  });

  it("does not arm on an inline control inside the row", () => {
    fireTouch(link, "touchstart", { clientX: CENTER_X, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS + 100);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("drops the pending hold when the binder is disposed mid-touch", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    dispose();
    vi.advanceTimersByTime(LONG_PRESS_MS + 100);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
