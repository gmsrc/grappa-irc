// @vitest-environment jsdom
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { bindEdgeGesture } from "../lib/touchGesture";

// #308 INC-A — the edge-swipe directive glue, exercised in jsdom by synthesizing
// touch events. jsdom can't reproduce real iOS scroll physics (that's the
// device call, verified post-deploy — Playwright webkit ≠ iOS), but the
// directive's DECISION path is deterministic given the events: it just sequences
// the pure gates (touchZone / horizontalClaim / swipeDirection) across
// touchstart→move→end and calls back. What we prove here is the wiring + the
// hard constraint at the directive level: a vertical drag is never claimed, so
// preventDefault is never called and native vertical scroll is left alone.

const W = 400; // viewport width fed to the directive (jsdom has no layout)

type Pt = { clientX: number; clientY: number };

// Dispatch a touch-shaped Event. jsdom lacks a full TouchEvent constructor, so
// we shape a cancelable Event with the .touches/.changedTouches the directive
// reads — exercising the real listener code path. Returns the event so callers
// can assert defaultPrevented (the preventDefault-at-claim signal).
function fireTouch(el: HTMLElement, type: string, ...points: Pt[]): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const list = points as unknown as TouchList;
  Object.defineProperty(ev, "touches", {
    value: type === "touchend" ? ([] as unknown as TouchList) : list,
  });
  Object.defineProperty(ev, "changedTouches", { value: list });
  el.dispatchEvent(ev);
  return ev;
}

describe("bindEdgeGesture (right edge → open members)", () => {
  let el: HTMLDivElement;
  let onOpenMembers: Mock<() => void>;
  let dispose: () => void;

  beforeEach(() => {
    el = document.createElement("div");
    document.body.appendChild(el);
    onOpenMembers = vi.fn<() => void>();
    dispose = bindEdgeGesture(el, { viewportWidth: () => W, onOpenMembers });
  });

  it("opens the members pane on a horizontal-left swipe from the right edge", () => {
    fireTouch(el, "touchstart", { clientX: W - 5, clientY: 300 });
    fireTouch(el, "touchmove", { clientX: W - 60, clientY: 305 });
    fireTouch(el, "touchmove", { clientX: W - 130, clientY: 310 });
    fireTouch(el, "touchend", { clientX: W - 170, clientY: 312 });
    expect(onOpenMembers).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("preventDefaults the move only AFTER it claims the horizontal gesture", () => {
    fireTouch(el, "touchstart", { clientX: W - 5, clientY: 300 });
    const claimed = fireTouch(el, "touchmove", { clientX: W - 60, clientY: 305 });
    expect(claimed.defaultPrevented).toBe(true);
    dispose();
  });

  // THE hard constraint at the directive level: a vertical-dominant drag from
  // the very edge is NEVER claimed → preventDefault is never called → the
  // browser owns the vertical scroll untouched, and no drawer opens.
  it("NEVER claims a vertical drag from the edge (vertical scroll survives)", () => {
    fireTouch(el, "touchstart", { clientX: W - 5, clientY: 100 });
    const m1 = fireTouch(el, "touchmove", { clientX: W - 3, clientY: 200 });
    const m2 = fireTouch(el, "touchmove", { clientX: W - 6, clientY: 300 });
    fireTouch(el, "touchend", { clientX: W - 5, clientY: 360 });
    expect(m1.defaultPrevented).toBe(false);
    expect(m2.defaultPrevented).toBe(false);
    expect(onOpenMembers).not.toHaveBeenCalled();
    dispose();
  });

  it("ignores a horizontal swipe that starts in the CENTER (zone separation)", () => {
    fireTouch(el, "touchstart", { clientX: W / 2, clientY: 300 });
    const m = fireTouch(el, "touchmove", { clientX: W / 2 - 80, clientY: 305 });
    fireTouch(el, "touchend", { clientX: W / 2 - 160, clientY: 308 });
    expect(m.defaultPrevented).toBe(false);
    expect(onOpenMembers).not.toHaveBeenCalled();
    dispose();
  });

  it("does not open on a sub-threshold horizontal twitch from the edge", () => {
    fireTouch(el, "touchstart", { clientX: W - 5, clientY: 300 });
    fireTouch(el, "touchmove", { clientX: W - 15, clientY: 301 });
    fireTouch(el, "touchend", { clientX: W - 18, clientY: 302 });
    expect(onOpenMembers).not.toHaveBeenCalled();
    dispose();
  });

  it("stops responding after dispose (listeners removed)", () => {
    dispose();
    fireTouch(el, "touchstart", { clientX: W - 5, clientY: 300 });
    fireTouch(el, "touchmove", { clientX: W - 60, clientY: 305 });
    fireTouch(el, "touchend", { clientX: W - 170, clientY: 312 });
    expect(onOpenMembers).not.toHaveBeenCalled();
  });
});
