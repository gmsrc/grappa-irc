// #308 — mobile touch gestures, pure geometry. DOM-free so it unit-tests
// without touch physics (Playwright webkit ≠ real iOS scroll; the *feel* is a
// device call, verified by vjt post-deploy — here we prove the WIRING + the
// hard constraints). Screen y grows DOWNWARD; all coords are client px.
//
// This module is the shared, reusable core for the #308 gesture directive
// (INC-A right-edge drawer opener; INC-B center-swipe channel nav). It COMPOSES
// the proven pure helpers in `./swipe` (the ComposeBox #123 toolkit) rather
// than duplicating or modifying them — `swipe.ts` stays byte-identical so
// ComposeBox's production behaviour is untouched.
import { DRAG_SLOP_PX, type Point, swipeDirection } from "./swipe";

// A touch's starting zone across the viewport width. Edge gestures (open a
// drawer) start within `edgePx` of a screen edge; center gestures (channel
// nav, INC-B) start OUTSIDE both edge zones. The zone separation is what keeps
// "open drawer" and "change channel" unambiguous — one gesture per zone.
export type TouchZone = "left-edge" | "right-edge" | "center";

// Edge-zone width. ~20px per the spec: wide enough to hit deliberately, narrow
// enough that content taps/scrolls in the body are never mistaken for an edge
// gesture.
export const EDGE_ZONE_PX = 20;

// Angle gate for horizontal intent: the drag must be at least this many times
// more horizontal than vertical to be CLAIMED as a horizontal gesture. ≥1.5
// (spec k≈1.5–2). Higher = stricter (more travel is left to vertical scroll);
// this is the dial that protects the hard constraint. Device-tunable by vjt.
export const ANGLE_GATE_K = 1.5;

// Which edge zone (if any) a touch began in, given the viewport width. The
// boundary is inclusive: exactly `edgePx` from an edge still counts as that
// edge, so the reachable target is the full `edgePx` band.
export const touchZone = (
  startX: number,
  viewportWidth: number,
  edgePx: number = EDGE_ZONE_PX,
): TouchZone => {
  if (startX <= edgePx) return "left-edge";
  if (startX >= viewportWidth - edgePx) return "right-edge";
  return "center";
};

// Claim-late horizontal-intent gate — the vertical-scroll protector (the #308
// hard constraint). Returns true ONLY once the drag has cleared the slop AND is
// horizontal-dominant past the angle gate (`|dx| >= |dy| * k`). A
// vertical-dominant or ambiguous drag returns false, so the directive NEVER
// preventDefaults it and native vertical scroll (and its momentum/fling) is
// byte-for-byte untouched. Claiming is deliberately LATE: we never claim on
// touchstart (that would kill text selection) — only after horizontal intent
// is proven mid-drag.
export const horizontalClaim = (
  start: Point,
  current: Point,
  k: number = ANGLE_GATE_K,
  slopPx: number = DRAG_SLOP_PX,
): boolean => {
  const ax = Math.abs(current.x - start.x);
  const ay = Math.abs(current.y - start.y);
  if (ax <= slopPx) return false; // under the slop — still undecided
  return ax >= ay * k;
};

// Parameters for the right-edge → open-members gesture (INC-A gesture 1).
// `viewportWidth` is injected (not read off the element) so the geometry is
// testable in jsdom, which has no layout; the call site passes
// `() => window.innerWidth`.
export type EdgeGestureParams = {
  viewportWidth: () => number;
  onOpenMembers: () => void;
};

// Bind the right-edge swipe (right→center opens the members drawer) on `el`.
// Additive gesture — the BottomBar stays the primary nav (#71 ruling); this is
// just a second door onto the existing right rail. Returns a disposer the caller
// wraps in `onCleanup` (function refs fire only at mount and are NOT re-invoked
// with undefined at unmount as in React — #308 landmine 3 — so cleanup is
// explicit). Listeners are bound at ELEMENT level with a non-passive touchmove
// (Solid delegates touch to a single PASSIVE document listener where
// preventDefault silently no-ops — #308 landmine 1). The gesture is armed only
// when the touch begins in the right-edge zone, and it CLAIMS (preventDefault)
// late — only once horizontal intent is proven — so a vertical drag is left
// entirely to native scroll (the hard constraint).
export function bindEdgeGesture(el: HTMLElement, params: EdgeGestureParams): () => void {
  let start: Point | null = null;
  let armed = false; // touch began in the right-edge zone
  let claimed = false; // horizontal intent proven → we own the gesture

  const onStart = (e: TouchEvent): void => {
    const t = e.touches.length === 1 ? e.touches[0] : undefined;
    claimed = false;
    if (t === undefined) {
      start = null;
      armed = false;
      return;
    }
    start = { x: t.clientX, y: t.clientY };
    armed = touchZone(t.clientX, params.viewportWidth()) === "right-edge";
  };

  const onMove = (e: TouchEvent): void => {
    if (!armed || start === null || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t === undefined) return;
    if (!claimed) {
      if (!horizontalClaim(start, { x: t.clientX, y: t.clientY })) return;
      claimed = true;
    }
    // Own the gesture: suppress native pan + drag-to-select. Reached ONLY after
    // a horizontal claim, so a vertical scroll is never preventDefaulted.
    e.preventDefault();
  };

  const onEnd = (e: TouchEvent): void => {
    const s = start;
    const wasClaimed = claimed;
    start = null;
    armed = false;
    claimed = false;
    if (!wasClaimed || s === null) return;
    const t = e.changedTouches[0];
    if (t === undefined) return;
    // right→center is a LEFT swipe (x decreases); swipeDirection floors the
    // travel at SWIPE_MIN_PX, so a claimed-but-short pull does not open.
    if (swipeDirection(s, { x: t.clientX, y: t.clientY }) === "left") {
      params.onOpenMembers();
    }
  };

  el.addEventListener("touchstart", onStart, { passive: true });
  el.addEventListener("touchmove", onMove, { passive: false });
  el.addEventListener("touchend", onEnd, { passive: true });
  return () => {
    el.removeEventListener("touchstart", onStart);
    el.removeEventListener("touchmove", onMove);
    el.removeEventListener("touchend", onEnd);
  };
}
