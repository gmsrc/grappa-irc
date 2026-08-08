import { channelKey } from "./channelKey";
import { getDraft, setDraft } from "./compose";

// Append `text` to a window's compose draft and leave the caret at the very
// end, focused and ready to keep typing.
//
// Lifted out of `Shell`'s `insertIntoCompose` (the off-compose printable-key
// handler) when #1067 needed the same verb for the reply quote: append, focus,
// caret at end. Two copies of this dance would be two places to forget
// `preventScroll` in. It is deliberately NOT `pasteRoute.insertPastedText` —
// that one is PASTE semantics (insert at the caret, replacing any selection),
// which for a quote would splice the quote into the middle of a half-typed
// word.
//
// DOM-touching by nature (the caret is not in the store), so it lives here
// rather than in `lib/compose.ts`, which is deliberately DOM-free.
export function appendToCompose(networkSlug: string, channelName: string, text: string): void {
  const ta = document.querySelector<HTMLTextAreaElement>(".compose-box textarea");
  if (ta === null) return;
  const key = channelKey(networkSlug, channelName);
  const next = getDraft(key) + text;
  setDraft(key, next);
  // UX-6 D9 — `preventScroll: true` short-circuits iOS Safari's "scroll the
  // focused input into view" auto-scroll path (WebKit `_zoomToFocusRect` in
  // WKContentView). Baseline since iOS Safari 15.5; without it iOS shifts the
  // layout viewport up by ~vv.offsetTop to "centre" the textarea — the root
  // cause of the UX-6-D bugs chased for 8 iterations.
  ta.focus({ preventScroll: true });
  // A Solid signal write does not immediately reflect in the textarea; place
  // the caret on the next microtask, once the controlled value has flushed.
  queueMicrotask(() => {
    ta.setSelectionRange(next.length, next.length);
  });
}
