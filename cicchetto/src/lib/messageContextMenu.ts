// #1115 — the scrollback's DESKTOP door to the message menu. #1067 built the
// menu (Copy / Reply / Select…) and gave it exactly ONE opener, a touch
// long-press, so a mouse user got the browser's own menu and none of ours.
// This is the second door, not a replacement: the touch stream stays entirely
// with `bindMessageGestures`.
//
// A separate binder rather than a branch inside that one. `bindMessageGestures`
// documents itself as the scrollback's one TOUCH-gesture owner and exists
// because a swipe and a hold share `touchstart→move→end` state; a `contextmenu`
// handler shares none of it and would sit inert through every touch event it
// was handed.
//
// One event covers the whole input matrix: right-click, Ctrl+click on macOS,
// and the keyboard Menu key all arrive as `contextmenu`. We never look at
// `button` or synthesize from `mouse*`/`pointer*`, so no modality is
// special-cased and none is missed.
//
// Bound ONCE on the scroll container and resolving the row via `closest`, for
// the same reason the touch owner is: a listener per rendered row would be
// hundreds of registrations churning on every append. Not delegated through
// Solid's JSX `onContextMenu` either — Solid's delegated handlers run at the
// document, i.e. AFTER this container listener in the bubble path, which is
// exactly the ordering that lets the nick's own right-click keep working (see
// the exclude below).
import { SELECTABLE_TEXT_EXCLUDE } from "./keepKeyboard";
import { MESSAGE_ROW_SELECTOR } from "./messageGestures";
import { disarmMessageSelection } from "./messageMenu";
import type { Point } from "./swipe";

export type MessageContextMenuParams = {
  onContextMenu: (row: HTMLElement, at: Point) => void;
};

export function bindMessageContextMenu(
  el: HTMLElement,
  params: MessageContextMenuParams,
): () => void {
  const onContextMenu = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    if (target === null) return;
    // A live selection means the operator wants the browser's own copy /
    // search / spellcheck menu over that selection — the same stand-down the
    // touch owner takes mid-selection. Deliberately ANY live selection, not
    // just one covering the cursor: it is the predicate already in use here,
    // and "covers the cursor" is not something the platforms agree on.
    const selection = window.getSelection();
    if (selection !== null && !selection.isCollapsed) return;
    // issue 1857 — and past that stand-down, a callout re-enable still latched
    // on <html> is stale. This door is not mouse-only in practice: `platform.ts`
    // puts `is-ios` on iPadOS in desktop-mode, where a trackpad's secondary
    // click arrives here, so a stale latch left by this door is the same
    // two-menus-for-one-press the touch owner disarms against.
    //
    // Ahead of the exclude below — and that is why the selection stand-down
    // moved above it — for the touch owner's reason: the latch is a
    // document-level fact and the callout it lifts covers the whole
    // scrollback, so a press we hand straight back still ends it. Both guards
    // are side-effect-free early returns, so their order is free.
    disarmMessageSelection();
    // The inline controls own their own right-click: the nick opens
    // UserContextMenu, and a link's native menu (open in new tab, copy link
    // address) beats anything we could offer. The SAME exclude the touch owner
    // and keepKeyboard use, so the three policies cannot drift. Returning
    // WITHOUT preventDefault is load-bearing — the nick's Solid-delegated
    // handler runs after us and must inherit a live event.
    if (target.closest(SELECTABLE_TEXT_EXCLUDE) !== null) return;
    const row = target.closest<HTMLElement>(MESSAGE_ROW_SELECTOR);
    if (row === null) return;
    e.preventDefault();
    params.onContextMenu(row, { x: e.clientX, y: e.clientY });
  };

  el.addEventListener("contextmenu", onContextMenu);
  return () => el.removeEventListener("contextmenu", onContextMenu);
}
