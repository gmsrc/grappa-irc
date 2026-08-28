import type { JSX } from "solid-js";

// issue 1831 — dismiss-on-backdrop, armed by the PRESS instead of by the click.
//
// The bug this exists to make impossible. A modal opened synchronously from
// the compose line — `/banlist` and bare `/mode` both reach their
// `open*Modal` with no `await` ahead of them — mounts a full-region backdrop
// while the finger is still on the send button. A touch dispatches its compat
// mouse events (`mousedown`, `mouseup`, `click`) AFTER the touch ends, and
// each is hit-tested against the layout as it stands THEN: the backdrop is
// already there, so the click lands on it and the dismiss fires in the same
// gesture that opened the modal. The operator sees nothing happen.
//
// The send button cannot defend against this. Its own click swallow
// (#925/#1059) only guards a click that still reaches the BUTTON, and this
// one no longer does — the target moved out from under it.
//
// Why this shape and not a timer. #1059 already ruled on the alternative, for
// the twin problem on the button: deferring the guard by a frame "makes the
// guard timing-dependent, which is the shape of the bug, not of its remedy".
// A press-armed dismiss is structural — a backdrop that never received the
// pointerdown beginning the interaction cannot be dismissed by its click,
// whatever the timing.
//
// It is the same doctrine #925 wrote for the send button: ACTIVATION RIDES
// THE POINTER, NOT THE CLICK. This is the dismissal half of it.
//
// A mouse never reproduced the bug and is unaffected by the cure: `mousedown`
// fires on the button BEFORE the modal opens, so the click resolves to the
// common ancestor of a button and a backdrop rather than to the backdrop, and
// a genuine mouse click on the scrim still carries its own pointerdown.
//
// Not a singleton: `armed` is per-backdrop interaction state, so each modal
// calls this once for its own scrim.
//
// Spread the pair at your peril — pass the two handlers as explicit props.
// `{...dismiss}` compiles and behaves identically, but biome then cannot see
// a click handler on the element and quietly retires the `a11y` suppressions
// the scrim carries (measured: four `suppressions/unused` the moment the
// literal `onClick` left the JSX). Losing a lint by accident is the sort of
// thing that is only ever noticed much later.
export type BackdropDismiss = {
  onPointerDown: JSX.EventHandler<HTMLDivElement, PointerEvent>;
  onClick: JSX.EventHandler<HTMLDivElement, MouseEvent>;
};

export const createBackdropDismiss = (close: () => void): BackdropDismiss => {
  let armed = false;

  return {
    // The target test lives HERE and not on the click, and the asymmetry is
    // measured rather than stylistic. A dialog inside the scrim stops the
    // CLICK from bubbling but not the POINTERDOWN, so a press that begins
    // inside the modal reaches this handler with `target` set to the dialog:
    // assignment (never `||=`) DISARMS on it, which is also what makes a drag
    // begun inside the modal and released over the scrim harmless. That is
    // the same "released inside" discipline the send button hit-tests for.
    onPointerDown: (e) => {
      armed = e.target === e.currentTarget;
    },
    // Always disarm, dismiss only if this click completes an interaction the
    // backdrop itself began. Clearing unconditionally means an aborted press
    // cannot leave the scrim primed for the next stray click.
    //
    // No target test on this side: the arming already subsumes it. An inner
    // click can only arrive here having been preceded by an inner press,
    // which disarmed — so the guard would hold even for a dialog that forgot
    // its own `stopPropagation`. Kept honest by measurement, not by taste:
    // adding `&& e.target === e.currentTarget` back is a mutant no test in
    // this suite can kill (34/34 still green with it), and untestable
    // defensive code is the shape that hides the next bug.
    onClick: () => {
      const beganHere = armed;
      armed = false;
      if (beganHere) close();
    },
  };
};
