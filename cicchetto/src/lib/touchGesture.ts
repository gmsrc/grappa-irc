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

// The mirror of `horizontalClaim`, for gestures whose axis is the other one
// (#1438's swipe-to-dismiss). Same shape, same slop, same angle gate, axes
// swapped: claim ONLY once the drag clears the slop AND is vertical-dominant
// past `k`. A horizontal-dominant or ambiguous drag returns false, so the
// caller never preventDefaults it and whatever owns the horizontal axis keeps
// it — which is how the dismiss gesture leaves a `<video>` scrubber alone, and
// how a future left/right binding on the same surface stays available.
//
// It lives here rather than in the media viewer for the reason this module
// exists: the angle gate is one decision, and a second copy is the drift that
// makes two gestures on one surface disagree about what counts as vertical.
export const verticalClaim = (
  start: Point,
  current: Point,
  k: number = ANGLE_GATE_K,
  slopPx: number = DRAG_SLOP_PX,
): boolean => {
  const ax = Math.abs(current.x - start.x);
  const ay = Math.abs(current.y - start.y);
  if (ay <= slopPx) return false; // under the slop — still undecided
  return ay >= ax * k;
};

// The ONE place "single finger only" is spelled, for the binders whose gesture
// a second finger cancels rather than modifies: a pinch (#213) belongs to the
// content, not to them. It lives here rather than in one binder because the
// predicate is shared, and a second copy is what lets two gestures on one app
// disagree about when a touch stops being theirs. `bindMessageGestures` keeps
// its own `firstTouch` on purpose — that one is a different predicate (it
// falls back to `changedTouches` and does its arity check separately).
export function soleTouch(e: TouchEvent): Touch | undefined {
  const list = e.touches.length > 0 ? e.touches : e.changedTouches;
  return list.length === 1 ? list[0] : undefined;
}

// Parameters for the two edge → open-drawer gestures. `viewportWidth` is
// injected (not read off the element) so the geometry is testable in jsdom,
// which has no layout; the call site passes `() => window.innerWidth`.
export type EdgeGestureParams = {
  viewportWidth: () => number;
  onOpenMembers: () => void;
  onOpenSidebar: () => void;
};

// Bind BOTH edge swipes on `el`: right→center opens the members drawer (#308
// INC-A gesture 1), left→center opens the channel sidebar (#1041). Additive
// gestures — the BottomBar stays the primary nav (#71 ruling); each is just a
// second door onto a rail. Returns a disposer the caller wraps in `onCleanup`
// (function refs fire only at mount and are NOT re-invoked with undefined at
// unmount as in React — #308 landmine 3 — so cleanup is explicit). Listeners
// are bound at ELEMENT level with a non-passive touchmove (Solid delegates
// touch to a single PASSIVE document listener where preventDefault silently
// no-ops — #308 landmine 1). The gesture is armed only when the touch begins in
// an edge zone, and it CLAIMS (preventDefault) late — only once horizontal
// intent is proven — so a vertical drag is left entirely to native scroll (the
// hard constraint).
//
// Terminal classification only: the drawer is decided at `touchend`, nothing is
// reported during the drag. Per vjt's #1041 ruling ("non ci formalizziamo,
// l'animazione può partire a touchend") a follow-the-finger panel is explicitly
// NOT required, and it is what would force a progress channel through here.
//
// The zone AND the direction must agree — a rightward pull from the right edge
// (or a leftward one from the left edge) points off-screen and opens nothing.
// Keeping the armed zone rather than a bare boolean is what makes the two arms
// unable to collapse into one another.
export function bindEdgeGesture(el: HTMLElement, params: EdgeGestureParams): () => void {
  let start: Point | null = null;
  let armedZone: "left-edge" | "right-edge" | null = null; // null = not armed
  let claimed = false; // horizontal intent proven → we own the gesture

  const onStart = (e: TouchEvent): void => {
    const t = e.touches.length === 1 ? e.touches[0] : undefined;
    claimed = false;
    if (t === undefined) {
      start = null;
      armedZone = null;
      return;
    }
    start = { x: t.clientX, y: t.clientY };
    const zone = touchZone(t.clientX, params.viewportWidth());
    armedZone = zone === "center" ? null : zone;
  };

  const onMove = (e: TouchEvent): void => {
    if (armedZone === null || start === null || e.touches.length !== 1) return;
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
    const zone = armedZone;
    const wasClaimed = claimed;
    start = null;
    armedZone = null;
    claimed = false;
    if (!wasClaimed || s === null || zone === null) return;
    const t = e.changedTouches[0];
    if (t === undefined) return;
    // right→center is a LEFT swipe (x decreases), left→center a RIGHT one;
    // swipeDirection floors the travel at SWIPE_MIN_PX, so a claimed-but-short
    // pull does not open either drawer.
    const direction = swipeDirection(s, { x: t.clientX, y: t.clientY });
    if (zone === "right-edge" && direction === "left") params.onOpenMembers();
    if (zone === "left-edge" && direction === "right") params.onOpenSidebar();
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
