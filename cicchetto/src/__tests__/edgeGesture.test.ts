// @vitest-environment jsdom
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { bindEdgeGesture } from "../lib/touchGesture";
import { fireTouch } from "./helpers/touchEvents";

// #308 INC-A — the edge-swipe directive glue, exercised in jsdom by synthesizing
// touch events. jsdom can't reproduce real iOS scroll physics (that's the
// device call, verified post-deploy — Playwright webkit ≠ iOS), but the
// directive's DECISION path is deterministic given the events: it just sequences
// the pure gates (touchZone / horizontalClaim / swipeDirection) across
// touchstart→move→end and calls back. What we prove here is the wiring + the
// hard constraint at the directive level: a vertical drag is never claimed, so
// preventDefault is never called and native vertical scroll is left alone.

const W = 400; // viewport width fed to the directive (jsdom has no layout)

let el: HTMLDivElement;
let onOpenMembers: Mock<() => void>;
let onOpenSidebar: Mock<() => void>;
let dispose: () => void;

beforeEach(() => {
  el = document.createElement("div");
  document.body.appendChild(el);
  onOpenMembers = vi.fn<() => void>();
  onOpenSidebar = vi.fn<() => void>();
  dispose = bindEdgeGesture(el, { viewportWidth: () => W, onOpenMembers, onOpenSidebar });
});

describe("bindEdgeGesture (right edge → open members)", () => {
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

  // Direction gate, right edge: the members drawer lives at the right, so only
  // right→center (a LEFT swipe) reveals it. A RIGHTWARD pull from the right
  // edge points off-screen — it must open nothing, least of all the LEFT
  // drawer, whose own arm is the opposite zone.
  it("opens nothing on a RIGHTWARD swipe from the right edge (direction gate)", () => {
    fireTouch(el, "touchstart", { clientX: W - 5, clientY: 300 });
    const claimed = fireTouch(el, "touchmove", { clientX: W + 40, clientY: 304 });
    fireTouch(el, "touchend", { clientX: W + 90, clientY: 306 });
    expect(claimed.defaultPrevented).toBe(true); // armed + horizontal: it DID claim
    expect(onOpenMembers).not.toHaveBeenCalled();
    expect(onOpenSidebar).not.toHaveBeenCalled();
  });
});

// #1041 — the mirror arm: left→center opens the left channel sidebar. Same
// claim-late gate, same terminal classification, opposite zone AND opposite
// direction. These cases exist so the two arms can never collapse into one
// another: a left-edge gesture must NEVER reach onOpenMembers and vice versa.
describe("bindEdgeGesture (left edge → open sidebar)", () => {
  it("opens the sidebar on a horizontal-right swipe from the left edge", () => {
    fireTouch(el, "touchstart", { clientX: 5, clientY: 300 });
    fireTouch(el, "touchmove", { clientX: 60, clientY: 305 });
    fireTouch(el, "touchmove", { clientX: 130, clientY: 310 });
    fireTouch(el, "touchend", { clientX: 170, clientY: 312 });
    expect(onOpenSidebar).toHaveBeenCalledTimes(1);
    expect(onOpenMembers).not.toHaveBeenCalled();
    dispose();
  });

  it("preventDefaults the move only AFTER it claims the horizontal gesture", () => {
    fireTouch(el, "touchstart", { clientX: 5, clientY: 300 });
    const claimed = fireTouch(el, "touchmove", { clientX: 60, clientY: 305 });
    expect(claimed.defaultPrevented).toBe(true);
    dispose();
  });

  // THE hard constraint on the new arm: a vertical-dominant drag from the left
  // edge is never claimed → never preventDefaulted → native vertical scroll is
  // byte-for-byte untouched, and no drawer opens.
  it("NEVER claims a vertical drag from the left edge (vertical scroll survives)", () => {
    fireTouch(el, "touchstart", { clientX: 5, clientY: 100 });
    const m1 = fireTouch(el, "touchmove", { clientX: 7, clientY: 200 });
    const m2 = fireTouch(el, "touchmove", { clientX: 4, clientY: 300 });
    fireTouch(el, "touchend", { clientX: 5, clientY: 360 });
    expect(m1.defaultPrevented).toBe(false);
    expect(m2.defaultPrevented).toBe(false);
    expect(onOpenSidebar).not.toHaveBeenCalled();
    dispose();
  });

  // Direction gate, left edge: a LEFTWARD pull from the left edge points
  // off-screen. It must open nothing — in particular it must not fall through
  // to the members arm, which reads the same "left" swipeDirection.
  it("opens nothing on a LEFTWARD swipe from the left edge (direction gate)", () => {
    fireTouch(el, "touchstart", { clientX: 18, clientY: 300 });
    const claimed = fireTouch(el, "touchmove", { clientX: -20, clientY: 304 });
    fireTouch(el, "touchend", { clientX: -60, clientY: 306 });
    expect(claimed.defaultPrevented).toBe(true); // armed + horizontal: it DID claim
    expect(onOpenSidebar).not.toHaveBeenCalled();
    expect(onOpenMembers).not.toHaveBeenCalled();
    dispose();
  });

  it("ignores a horizontal swipe that starts in the CENTER (zone separation)", () => {
    fireTouch(el, "touchstart", { clientX: W / 2, clientY: 300 });
    const m = fireTouch(el, "touchmove", { clientX: W / 2 + 80, clientY: 305 });
    fireTouch(el, "touchend", { clientX: W / 2 + 160, clientY: 308 });
    expect(m.defaultPrevented).toBe(false);
    expect(onOpenSidebar).not.toHaveBeenCalled();
    dispose();
  });

  it("does not open on a sub-threshold horizontal twitch from the edge", () => {
    fireTouch(el, "touchstart", { clientX: 5, clientY: 300 });
    fireTouch(el, "touchmove", { clientX: 15, clientY: 301 });
    fireTouch(el, "touchend", { clientX: 18, clientY: 302 });
    expect(onOpenSidebar).not.toHaveBeenCalled();
    dispose();
  });

  it("stops responding after dispose (listeners removed)", () => {
    dispose();
    fireTouch(el, "touchstart", { clientX: 5, clientY: 300 });
    fireTouch(el, "touchmove", { clientX: 60, clientY: 305 });
    fireTouch(el, "touchend", { clientX: 170, clientY: 312 });
    expect(onOpenSidebar).not.toHaveBeenCalled();
  });
});
