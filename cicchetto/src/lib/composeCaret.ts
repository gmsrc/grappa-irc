// #173 + #1105 — "caret at the end, and visible", the ONE copy.
//
// The compose textarea is `rows={1}` with `resize: none`, so any draft that
// wraps past the first line turns it into an internal scroll container. The
// browser does NOT scroll on `setSelectionRange`, so placing the caret at the
// end of an overflowing draft leaves the element pinned at `scrollTop === 0`
// with the caret below the fold — you type blind.
//
// #173 met this on history recall and fixed it inside `ComposeBox`. #1105 met
// the SAME defect on the reply quote, because `appendToCompose` carried its
// own copy of "caret at end" without the scroll. Two copies were two places to
// forget the second line in, and one of them did. Hence one function: any new
// caller that wants the caret at the end gets the reveal for free.
//
// Scope: END-of-draft callers only. Paste (`pasteRoute.insertPastedText`) and
// tab-complete land the caret at an arbitrary offset, where
// `scrollTop = scrollHeight` would scroll past it — those need
// caret-position-aware scrolling, which is a different mechanism.
//
// `queueMicrotask` is load-bearing: a Solid signal write does not reflect in
// the textarea synchronously, so both the caret and the measurement must run
// after the controlled value has committed to the DOM. Reading the length off
// the live element (rather than the string the caller just wrote) keeps the
// two in step even if the commit is late.
export function placeCaretAtEndInView(el: HTMLTextAreaElement): void {
  queueMicrotask(() => {
    const end = el.value.length;
    el.setSelectionRange(end, end);
    el.scrollTop = el.scrollHeight;
  });
}
