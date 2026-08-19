// #1445 — pull down from the top of a scroller to ask for a refresh, with the
// affordance following the finger. The channel directory is the first consumer;
// the module is written pane-agnostic because this is the PWA's first
// pull-to-refresh and whatever shape it takes becomes the pattern for the rest.
//
// The FOURTH binder over one core, not a fourth gesture engine: it composes
// `./swipe`'s direction/floor geometry and `./touchGesture`'s angle gate,
// exactly as `bindEdgeGesture`, `bindMessageGestures` and `bindDismissGesture`
// do. Four answers to "what counts as a swipe" is the drift those three were
// each written to avoid.
//
// Element-level listeners with a non-passive touchmove: Solid delegates touch
// to a single PASSIVE document listener, where preventDefault silently no-ops
// (#308 landmine 1). Returns a disposer the caller wraps in `onCleanup` — Solid
// does NOT re-invoke a function ref with undefined at unmount the way React
// does (#308 landmine 3), so cleanup is explicit.
//
// Like `bindDismissGesture` it reports PROGRESS and writes no paint of its own:
// the pulled slot, its cap and its spinner belong to the pane, and a binder
// that knew about them would be a binder that knew about the directory.
import { type Point, SWIPE_MIN_PX, swipeDirection } from "./swipe";
import { soleTouch, verticalClaim } from "./touchGesture";

// How far down the finger must travel for the release to spend a refresh.
//
// Derived from `SWIPE_MIN_PX` rather than picked, so this does not become a
// second vocabulary for the same physical gesture. It is deliberately STRICTER
// than that floor: 40px answers "was this a gesture at all", while this answers
// "did they mean to spend a server round-trip and a disabled button for the
// length of a capture". Doubling is a defensible default, NOT a measurement —
// the same standing `DISMISS_COMMIT_FRACTION` carries in the sibling binder.
// vjt calibrates on-device; nothing here was verified on a phone.
export const PULL_COMMIT_PX = SWIPE_MIN_PX * 2;

// Worn by the bound element for exactly as long as the finger is driving a
// CLAIMED pull, so the stylesheet can drop its snap-back transition and let the
// slot track the finger instead of easing behind it. Same device as
// `SWIPING_CLASS` in `messageGestures` and `DRAGGING_CLASS` in the viewer.
export const PULLING_CLASS = "pull-gesture-active";

export type PullGestureParams = {
  // May the pull arm right now? The directory passes
  // `() => el.scrollTop === 0`: a pull is only a pull at the top of the list,
  // anywhere else the same drag is native scrolling.
  //
  // Injected rather than read off the element because this module is
  // DOM-generic and jsdom has no layout — the same reason `viewportWidth` and
  // `canDismiss` are injected in the sibling binders.
  canPull: () => boolean;
  // Running downward travel in px, floored at 0, on every claimed move. The
  // caller translates its slot and ramps the spinner with it, capping against
  // PULL_COMMIT_PX. Floored because a pull has no negative magnitude: once
  // claimed we own the touch, so a finger dragged back ABOVE its origin must
  // read as "no pull", never as an upward paint.
  onProgress: (dy: number) => void;
  // Released past the commit distance: ask for the refresh.
  onCommit: () => void;
  // Claimed but not committed, or cancelled: put the slot back.
  onRelease: () => void;
};

export function bindPullGesture(el: HTMLElement, params: PullGestureParams): () => void {
  let start: Point | null = null; // non-null ⇒ a touch is in flight
  let claimed = false; // downward intent proven at the top → we own the gesture

  const disarm = (): void => {
    start = null;
    claimed = false;
    el.classList.remove(PULLING_CLASS);
  };

  const onStart = (e: TouchEvent): void => {
    disarm();
    const t = soleTouch(e);
    if (t === undefined) return;
    start = { x: t.clientX, y: t.clientY };
  };

  const onMove = (e: TouchEvent): void => {
    if (start === null) return;
    const t = soleTouch(e);
    if (t === undefined) return;
    const current = { x: t.clientX, y: t.clientY };
    if (!claimed) {
      // DOWNWARD only. `verticalClaim` is direction-agnostic and the viewer's
      // dismiss commits either way, but a pull that claimed the upward drag
      // would preventDefault the most ordinary gesture there is — scrolling a
      // list. Mirror of the rightward-only gate in `bindMessageGestures`.
      if (current.y <= start.y) return;
      // Read LIVE, never snapshotted at touchstart. Before we claim, native
      // scroll is still running: a finger that drags UP first scrolls the list
      // away from the top and then comes back DOWN, and a touchstart snapshot
      // would claim that reversal as a pull with the list scrolled to 200px.
      // Same lesson as #123's scroll-boundary handoff, for the same reason.
      if (!params.canPull()) return;
      // Claim LATE and vertical-dominant: a horizontal drag is released whole,
      // so a future left/right binding on this surface stays possible.
      if (!verticalClaim(start, current)) return;
      claimed = true;
      el.classList.add(PULLING_CLASS);
    }
    // Own the gesture: suppress native pan. Reached ONLY after a downward
    // claim at the top of the scroller.
    if (e.cancelable) e.preventDefault();
    params.onProgress(Math.max(0, current.y - start.y));
  };

  const onEnd = (e: TouchEvent): void => {
    const s = start;
    const wasClaimed = claimed;
    disarm();
    if (!wasClaimed || s === null) return;
    const t = e.changedTouches[0];
    if (t === undefined) {
      params.onRelease();
      return;
    }
    // ONE gate, doing both halves: `swipeDirection` floors the travel at the
    // distance we hand it AND requires the vertical axis to dominate, so a
    // claimed pull that wandered sideways on the way out does not commit.
    //
    // Distance ONLY — no velocity route, deliberately unlike the viewer's
    // dismiss, which commits on a short fast flick as well. At the top of a
    // list a flick is the commonest thing a finger does, and the cost here is
    // asymmetric: a spurious commit spends an upstream LIST capture and
    // disables the refresh affordances for its whole duration, where a
    // spurious spring-back costs one repeated gesture. Adding the flick route
    // later is additive; taking it away after it has fired on people is not.
    if (swipeDirection(s, { x: t.clientX, y: t.clientY }, PULL_COMMIT_PX) === "down") {
      params.onCommit();
      return;
    }
    params.onRelease();
  };

  const onCancel = (): void => {
    const wasClaimed = claimed;
    disarm();
    if (wasClaimed) params.onRelease();
  };

  el.addEventListener("touchstart", onStart, { passive: true });
  el.addEventListener("touchmove", onMove, { passive: false });
  el.addEventListener("touchend", onEnd, { passive: true });
  el.addEventListener("touchcancel", onCancel, { passive: true });
  return () => {
    disarm();
    el.removeEventListener("touchstart", onStart);
    el.removeEventListener("touchmove", onMove);
    el.removeEventListener("touchend", onEnd);
    el.removeEventListener("touchcancel", onCancel);
  };
}
