import { createEffect, onCleanup } from "solid-js";

// Close-on-click-outside for lightweight rail popovers, as a shared verb.
//
// Extracted from `RailActions` (#500) when #682's radio picker became the
// second surface needing it — two call sites, one implementation, per
// CLAUDE.md rather than a copy with tweaks.
//
// WHY A LISTENER AND NOT A BACKDROP SCRIM. The modal family dismisses by
// covering the viewport with a click-catching element. That is wrong for a
// rail popover: the scrim SWALLOWS the click that dismissed it, so selecting
// a sidebar channel or focusing compose while a popover is open costs two
// gestures instead of one. A NON-blocking document listener closes the
// popover AND lets the click reach its target.
//
// Capture phase (`true`) on purpose: it must observe the click before a
// stopPropagation() anywhere in the tree can hide it.
//
// Registered only WHILE OPEN, and the opening click has already been
// dispatched by the time the effect runs, so a popover cannot dismiss itself
// on the very gesture that opened it. Anything inside `root` is exempt, which
// is what lets a launcher toggle and lets the popover's own rows be clicked;
// a row that should dismiss calls `onDismiss` itself.
export function createDismissOnOutsidePointer(
  isOpen: () => boolean,
  root: () => HTMLElement | undefined,
  onDismiss: () => void,
): void {
  createEffect(() => {
    if (!isOpen()) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      const el = root();
      if (el && target && !el.contains(target)) onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown, true));
  });
}
