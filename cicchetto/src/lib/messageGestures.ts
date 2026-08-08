// #1067 — the scrollback's ONE touch-gesture owner. Two gestures on a message
// row, both read off the SAME touchstart→touchmove→touchend stream:
//
//   * a left→right SWIPE fills the compose box with a quote of that message
//     (vjt's pivot on `#grappa`, 2026-08-08: "ok vjt-claude pivot usiamo swipe
//     / sx->dx si" — Telegram/WhatsApp style, the row slides and snaps back);
//   * a stationary HOLD opens the message menu (Copy / Reply / Select…),
//     replacing #366's programmatic whole-row select-all.
//
// One binder, not two: a swipe and a hold are the same touch until they aren't,
// and the discriminator is shared state ("has it moved yet"). Two binders would
// each keep their own copy and could both fire on one gesture — a hold that
// drifts 50px would open the menu AND reply.
//
// The right→left direction is deliberately NOT bound: #1067 leaves it open
// ("vabe vediamo come viene"), so we never claim it — an unclaimed drag keeps
// its native drag-to-select, and binding it later costs nothing.
//
// Element-level listeners with a non-passive touchmove/touchend, exactly like
// `bindEdgeGesture`: Solid delegates touch to a single PASSIVE document
// listener, where preventDefault silently no-ops (#308 landmine 1). Bound ONCE
// on the scroll container and resolving the row via `closest` — a listener per
// rendered row would be hundreds of registrations that churn on every append.
//
// Returns a disposer the caller wraps in `onCleanup` (Solid does NOT re-invoke
// a function ref with undefined at unmount the way React does — #308 landmine
// 3 — so cleanup is explicit).
import { LONG_PRESS_MS, SELECTABLE_TEXT_EXCLUDE } from "./keepKeyboard";
import { type Point, swipeDirection } from "./swipe";
import { horizontalClaim, touchZone } from "./touchGesture";

// How far the row is allowed to follow the finger. The slide is FEEDBACK ("this
// gesture is armed"), not a drag of the row anywhere, so it saturates well
// before the finger does — and a capped `translateX` keeps the row inside its
// own box, so the virtualised list never reflows behind it.
export const SWIPE_MAX_SLIDE_PX = 72;

// Jitter a finger is allowed while "holding still". Same value #366 used for
// the same job — a real hold on a phone is never pixel-perfect, and anything
// past this is a scroll or a swipe, not a press.
export const HOLD_MOVE_TOLERANCE_PX = 10;

// Suppresses the CSS snap-back transition while the finger is driving the row,
// so the slide tracks the finger instead of easing behind it.
export const SWIPING_CLASS = "scrollback-line-swiping";

const MESSAGE_ROW_SELECTOR = ".scrollback-line";

export type MessageGestureParams = {
  // Injected (not read off the element) so the zone geometry is testable in
  // jsdom, which has no layout. Call site passes `() => window.innerWidth`.
  viewportWidth: () => number;
  onReply: (row: HTMLElement) => void;
  onLongPress: (row: HTMLElement, at: Point) => void;
};

function firstTouch(e: TouchEvent): Touch | undefined {
  return e.touches[0] ?? e.changedTouches[0];
}

export function bindMessageGestures(el: HTMLElement, params: MessageGestureParams): () => void {
  let start: Point | null = null;
  let row: HTMLElement | null = null; // non-null ⇒ armed
  let claimed = false; // rightward intent proven → we own the gesture
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let held = false; // the menu opened during THIS touch

  const cancelHold = (): void => {
    if (holdTimer !== undefined) clearTimeout(holdTimer);
    holdTimer = undefined;
  };

  const release = (): void => {
    cancelHold();
    if (row !== null) {
      row.style.transform = "";
      row.classList.remove(SWIPING_CLASS);
    }
    start = null;
    row = null;
    claimed = false;
  };

  const onStart = (e: TouchEvent): void => {
    release();
    held = false;
    // Single finger only: a pinch (#213) is not a message gesture.
    if (e.touches.length !== 1) return;
    const t = firstTouch(e);
    if (t === undefined) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target === null) return;
    // The inline controls (#350 link, #354 nick, #648 channel, the [Join] CTA)
    // already own their own press meaning — the same exclude keepKeyboard uses,
    // so the two policies cannot drift.
    if (target.closest(SELECTABLE_TEXT_EXCLUDE) !== null) return;
    const line = target.closest<HTMLElement>(MESSAGE_ROW_SELECTOR);
    if (line === null) return;
    // Zone separation (#308/#1041): the left edge opens the channel sidebar and
    // the right edge the members drawer, both with a horizontal drag. Arming
    // only in the centre is what keeps the reply swipe from firing alongside
    // them — and it keeps our hands off the band iOS reserves for its own
    // back-swipe.
    if (touchZone(t.clientX, params.viewportWidth()) !== "center") return;
    start = { x: t.clientX, y: t.clientY };
    row = line;
    const at = start;
    const held_ = line;
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      held = true;
      // Disarm the swipe: this touch has become a press, and its release must
      // not also quote the message.
      start = null;
      row = null;
      params.onLongPress(held_, at);
    }, LONG_PRESS_MS);
  };

  const onMove = (e: TouchEvent): void => {
    if (start === null || row === null || e.touches.length !== 1) return;
    const t = firstTouch(e);
    if (t === undefined) return;
    const current = { x: t.clientX, y: t.clientY };
    if (
      Math.abs(current.x - start.x) > HOLD_MOVE_TOLERANCE_PX ||
      Math.abs(current.y - start.y) > HOLD_MOVE_TOLERANCE_PX
    ) {
      cancelHold(); // moving — a scroll or a swipe, no longer a press
    }
    if (!claimed) {
      // Claim LATE and RIGHTWARD only: a vertical-dominant drag is left whole
      // to native scroll (the #308 hard constraint), and a leftward one is left
      // to the browser because #1067 has not assigned it a meaning yet.
      if (current.x <= start.x) return;
      if (!horizontalClaim(start, current)) return;
      claimed = true;
      row.classList.add(SWIPING_CLASS);
    }
    // Own the gesture: suppress native pan + drag-to-select. Reached ONLY after
    // a rightward horizontal claim.
    if (e.cancelable) e.preventDefault();
    const slide = Math.min(current.x - start.x, SWIPE_MAX_SLIDE_PX);
    row.style.transform = `translateX(${slide}px)`;
  };

  const onEnd = (e: TouchEvent): void => {
    // A hold already opened the menu: swallow the release so the browser
    // synthesizes no click, which would otherwise land on the menu's own
    // backdrop and close it the instant it appeared.
    if (held) {
      held = false;
      if (e.cancelable) e.preventDefault();
      release();
      return;
    }
    const s = start;
    const line = row;
    const wasClaimed = claimed;
    release();
    if (!wasClaimed || s === null || line === null) return;
    const t = e.changedTouches[0];
    if (t === undefined) return;
    // swipeDirection floors the travel at SWIPE_MIN_PX, so a claimed-but-short
    // pull slides and snaps back without quoting anything.
    if (swipeDirection(s, { x: t.clientX, y: t.clientY }) === "right") params.onReply(line);
  };

  const onCancel = (): void => {
    held = false;
    release();
  };

  el.addEventListener("touchstart", onStart, { passive: true });
  el.addEventListener("touchmove", onMove, { passive: false });
  el.addEventListener("touchend", onEnd, { passive: false });
  el.addEventListener("touchcancel", onCancel, { passive: true });
  return () => {
    release();
    el.removeEventListener("touchstart", onStart);
    el.removeEventListener("touchmove", onMove);
    el.removeEventListener("touchend", onEnd);
    el.removeEventListener("touchcancel", onCancel);
  };
}
