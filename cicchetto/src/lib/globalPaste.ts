// #352 — global Ctrl/Cmd+V. A paste fired while focus is OFF the compose
// textarea (scrollback, body, a just-closed menu) currently drops on the floor:
// the textarea's onPaste only fires when the textarea already holds focus. This
// installs ONE document-level paste listener at boot (same boot-time global
// pattern as lib/keepKeyboard) that, when a paste lands on a non-editable
// surface, focuses the compose bar and routes the payload through the SAME
// shared router the textarea uses (lib/pasteRoute) — text inserts at the caret,
// image/file uploads.
//
// Boundary (from the issue):
//   * Don't hijack when a DIFFERENT editable field owns focus (search, a
//     settings input, another modal's field) — nor when the compose textarea
//     itself is focused (its own onPaste already handles it; this listener
//     would double-fire).
//   * Respect open modals with their own paste semantics (media viewer, theme
//     editor, upload privacy modal): never steal a paste to a compose box that
//     sits hidden behind an overlay.
//
// iOS caveat: Safari may deny clipboard read outside a user-gesture-bound
// editable target, so the intercepted event's clipboardData can be empty. We
// focus the compose bar FIRST and unconditionally, so even when the payload
// can't be read the user's paste (or next keystroke) lands in the compose box —
// the graceful degrade the issue calls for. (routeClipboardPaste no-ops on
// empty text; see its nativeInsertAvailable=false branch.)

import { overlayCount } from "./overlayScrollLock";
import { routeClipboardPaste } from "./pasteRoute";
import { selectedChannel } from "./selection";

// The mounted compose textarea carries `data-compose-input` (ComposeBox.tsx) —
// the ONE compose surface, and only present for windows that HAVE a compose box
// (channel / query / server), never for home / mentions / admin. Querying by it
// avoids coupling to the a11y label text.
export const COMPOSE_INPUT_SELECTOR = "textarea[data-compose-input]";

// True when a paste should be left to `el` rather than hijacked to compose:
// any text-entry field or contentEditable region (incl. the compose textarea
// itself, whose own onPaste handles it).
export function isEditableTarget(el: Element | null): boolean {
  if (el === null) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLElement && el.isContentEditable === true;
}

export function handleGlobalPaste(e: ClipboardEvent): void {
  if (typeof document === "undefined") return;
  // Respect open modals (media viewer, theme editor, upload privacy modal).
  if (overlayCount() > 0) return;
  // Leave the paste alone when an editable field — or the compose textarea
  // itself — owns focus.
  if (isEditableTarget(document.activeElement)) return;
  const ta = document.querySelector<HTMLTextAreaElement>(COMPOSE_INPUT_SELECTOR);
  if (ta === null) return; // no compose surface (home / mentions / admin / nothing selected)
  const sel = selectedChannel();
  if (sel === null) return;
  // Focus FIRST — the visible outcome (#352) AND the iOS graceful degrade.
  ta.focus();
  // nativeInsertAvailable = false: the browser performs no native insert into a
  // textarea that was unfocused when the paste fired, so below-threshold text is
  // inserted explicitly by the router.
  routeClipboardPaste(e, ta, sel.networkSlug, sel.channelName, false);
}

// Install the single document-level paste listener at boot. Mirrors
// installKeyboardPreserve's SSR-safe default target; there is no uninstall path
// (app-lifetime listener, torn down only by a full page reload — the same
// contract as the other boot-time global listeners in main.tsx).
export function installGlobalPaste(
  target: Document | undefined = typeof document !== "undefined" ? document : undefined,
): void {
  if (!target) return;
  target.addEventListener("paste", handleGlobalPaste);
}
