import { createSignal } from "solid-js";
import type { ScrollbackMessage } from "./api";
import { copyText } from "./clipboard";
import type { Point } from "./swipe";
import { createToastQueue } from "./toasts";

// #1067 — the long-press message menu: what it is open OVER, and the two verbs
// that are only meaningful on a rendered row (Copy, Select…). Reply is NOT
// here — it is `lib/replyQuote`, shared verbatim with the swipe, because the
// menu item and the gesture must not be able to drift into two behaviours.
//
// The menu replaces #366's programmatic whole-row select-all, which was the
// long-press affordance and produced both reported symptoms: it only ran with
// the keyboard up, and the range it installed had no draggable endpoints.

export type MessageMenuTarget = {
  msg: ScrollbackMessage;
  // The rendered row. Copy reads its text (what the operator SEES, timestamp
  // and sender included — the same span #366 grabbed) and Select… installs the
  // range over it. The gesture already resolved it; re-finding it by id here
  // would be a second lookup that can disagree with the first.
  row: HTMLElement;
  networkSlug: string;
  channelName: string;
  at: Point;
};

const [messageMenu, setMessageMenu] = createSignal<MessageMenuTarget | null>(null);

export { messageMenu };

export function openMessageMenu(target: MessageMenuTarget): void {
  setMessageMenu(target);
}

export function closeMessageMenu(): void {
  setMessageMenu(null);
}

// A clipboard failure must be visible (#1067 acceptance). It rides the app's
// ONE toast surface rather than `copyText`'s throw: the stakes here are not the
// show-once-secret stakes that helper was written for, and the way out it names
// — "select the text and copy it by hand" — is literally the next item in the
// same menu. Failure only; a successful copy is silent, the menu closing is the
// feedback.
const copyFailures = createToastQueue<{ message: string }>();
export const copyToasts = copyFailures.toasts;
export const dismissCopyToast = copyFailures.dismiss;

// Never rejects: the failure IS the toast, so callers can `void` this without
// leaving an unhandled rejection behind.
export async function copyMessageRow(row: HTMLElement): Promise<void> {
  try {
    await copyText(row.textContent ?? "");
  } catch (err) {
    copyFailures.queue({ message: err instanceof Error ? err.message : String(err) });
  }
}

// Lifts `html.is-ios`'s blanket `-webkit-touch-callout: none` for the duration
// of one selection (default.css pairs this class with the re-enable). Scoping
// it in TIME rather than in space is what keeps the two long-presses from
// colliding: with the callout permanently back on the scrollback, every hold
// would race iOS's own selection UI against this menu.
export const SELECTING_CLASS = "is-selecting";

// Hand the operator a real, adjustable native selection over the row and get
// out of the way. Returns whether a selection could be installed.
//
// NOT device-verified: the callout ⇄ grab-handle link is read from the platform
// contract and from the code, and neither jsdom nor Playwright webkit
// reproduces iOS selection UI. #1067 says as much about its own diagnosis.
export function selectMessageText(row: HTMLElement): boolean {
  const selection = window.getSelection();
  if (selection === null) return false;
  const range = document.createRange();
  range.selectNodeContents(row);
  selection.removeAllRanges();
  selection.addRange(range);
  document.documentElement.classList.add(SELECTING_CLASS);
  // Disarm the moment the operator is done. Without this the callout stays up
  // for the rest of the session and the next hold anywhere in the scrollback
  // pops iOS's own menu over ours.
  const onSelectionChange = (): void => {
    const live = window.getSelection();
    if (live !== null && live.toString() !== "") return;
    document.documentElement.classList.remove(SELECTING_CLASS);
    document.removeEventListener("selectionchange", onSelectionChange);
  };
  document.addEventListener("selectionchange", onSelectionChange);
  return true;
}
