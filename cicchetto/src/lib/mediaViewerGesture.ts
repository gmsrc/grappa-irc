// #1438 — swipe up or down to dismiss the media viewer, modal following the
// finger. Requested by vjt; the whole CONTAINER moves, not the picture inside a
// stationary chrome (vjt's ruling), and videos behave the same as images.
//
// This is not a new gesture engine. It COMPOSES `./swipe` (the #123 pure
// geometry toolkit — travel floor, direction, velocity) and `./touchGesture`'s
// angle gate, exactly as `bindEdgeGesture` and `bindMessageGestures` do. Three
// engines on one app would be three answers to "what counts as a swipe".
//
// Element-level listeners with a non-passive touchmove: Solid delegates touch
// to a single PASSIVE document listener, where preventDefault silently no-ops
// (#308 landmine 1). Returns a disposer the caller wraps in `onCleanup` —
// Solid does NOT re-invoke a function ref with undefined at unmount the way
// React does (#308 landmine 3), so cleanup is explicit.
//
// The gesture reports PROGRESS, which `bindEdgeGesture` deliberately does not:
// #1041 ruled a follow-the-finger panel out of scope there, and it is exactly
// the progress channel that ruling avoided. Here the follow IS the feature, so
// the caller gets `onProgress` and owns the paint — this module writes no
// transform of its own, because the modal and the backdrop move together and a
// binder that knew about both would be a binder that knew about the viewer.
import { isFastSwipe, type Point, swipeDirection } from "./swipe";
import { soleTouch, verticalClaim } from "./touchGesture";

// How far down (or up) the drag must reach to dismiss on distance alone,
// as a fraction of the viewport height. A fraction rather than a pixel
// constant because the same gesture has to feel the same on a phone and on a
// tablet, and because jsdom has no layout — the height is injected, like
// `viewportWidth` in the sibling binders.
//
// 0.15 is a defensible default, NOT a measurement — the same standing this
// module's velocity threshold carries in `swipe.ts` ("velocity feel is a device
// call"). vjt calibrates it on-device; nothing here was verified on a phone.
export const DISMISS_COMMIT_FRACTION = 0.15;

// Worn by the bound element for exactly as long as the finger is driving it, so
// the stylesheet can drop its snap-back transition and let the modal track the
// finger instead of easing behind it. Same device as `SWIPING_CLASS` in
// `messageGestures`.
export const DRAGGING_CLASS = "media-viewer-modal--dragging";

export type DismissGestureParams = {
  // Injected (not read off the element) because jsdom has no layout.
  viewportHeight: () => number;
  // Asked at touchstart, the way `bindMessageGestures` asks `canReply` per row:
  // this module is DOM-only and must stay that way. A zoomed image owns the
  // one-finger drag as a PAN, so the viewer answers false while its scale is
  // off the fit baseline — but a scale, or a media kind, in here would be a
  // second classifier racing the one that already exists.
  canDismiss: () => boolean;
  // Running vertical delta in px (negative = up), on every claimed move. The
  // caller translates the modal and ramps the backdrop with it.
  onProgress: (dy: number) => void;
  // Past the distance or the velocity: close, through the caller's normal
  // close path (#1121 / #535 — a dismiss that bypassed it would strand the
  // reader exactly the way those two issues closed).
  onCommit: () => void;
  // Claimed but not committed, or cancelled: put it back.
  onRelease: () => void;
};

export function bindDismissGesture(el: HTMLElement, params: DismissGestureParams): () => void {
  let start: Point | null = null; // non-null ⇒ armed
  let startedAt = 0; // touchstart timeStamp, for the velocity gate
  let claimed = false; // vertical intent proven → we own the gesture

  const disarm = (): void => {
    start = null;
    claimed = false;
    el.classList.remove(DRAGGING_CLASS);
  };

  const onStart = (e: TouchEvent): void => {
    disarm();
    const t = soleTouch(e);
    if (t === undefined) return;
    if (!params.canDismiss()) return;
    start = { x: t.clientX, y: t.clientY };
    startedAt = e.timeStamp;
  };

  const onMove = (e: TouchEvent): void => {
    if (start === null) return;
    const t = soleTouch(e);
    if (t === undefined) return;
    const current = { x: t.clientX, y: t.clientY };
    if (!claimed) {
      // Claim LATE and VERTICAL-dominant only. A horizontal drag is released
      // whole — it is how a `<video>` scrubber survives, and how a future
      // left/right binding on this surface stays possible.
      if (!verticalClaim(start, current)) return;
      claimed = true;
      el.classList.add(DRAGGING_CLASS);
    }
    // Own the gesture: suppress native pan. Reached ONLY after a vertical claim.
    if (e.cancelable) e.preventDefault();
    params.onProgress(current.y - start.y);
  };

  const onEnd = (e: TouchEvent): void => {
    const s = start;
    const wasClaimed = claimed;
    const elapsed = e.timeStamp - startedAt;
    disarm();
    if (!wasClaimed || s === null) return;
    const t = e.changedTouches[0];
    if (t === undefined) {
      params.onRelease();
      return;
    }
    const end = { x: t.clientX, y: t.clientY };
    // Two independent ways to mean it, the pair every photo viewer uses: a
    // deliberate long pull, or a short flick. `swipeDirection` floors the
    // travel at SWIPE_MIN_PX first, so neither route fires on a stray nudge.
    const direction = swipeDirection(s, end);
    const farEnough = Math.abs(end.y - s.y) >= params.viewportHeight() * DISMISS_COMMIT_FRACTION;
    const flicked = isFastSwipe(s, end, elapsed);
    if ((direction === "up" || direction === "down") && (farEnough || flicked)) {
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
