import type { ScrollbackMessage } from "./api";
import { appendToCompose } from "./composeAppend";
import { quotableBody } from "./quotableBody";

// #1067 — the reply verb, shared by the left→right swipe on a message row and
// the long-press menu's Reply item. Both doors, one code path.
//
// The quote is built from the MESSAGE, not from the rendered row: the row's
// text also carries the timestamp and the per-message prefix glyph (@/+), and
// scraping those back out is a parser nobody asked for.

// The tail the issue specifies verbatim: `<nick> quoted message<< `, trailing
// space included, so the answer is typed straight after the caret.
export const REPLY_QUOTE_TAIL = "<< ";

// The quote for a message, or null when there is nothing to reply to.
//
// #1107 — the gate and the plain-text extraction moved to `quotableBody`, which
// `addQuoteCommand` now shares. What stays here is the WRAPPER, which is the
// only part reply owns.
export function replyQuote(msg: ScrollbackMessage): string | null {
  const body = quotableBody(msg);
  if (body === null) return null;
  // #1126 — an action is NOT speech. Quoting `* vjt waves` as `<vjt> waves`
  // puts a sentence in someone's mouth that they never said, so the quote keeps
  // the `* nick …` form the scrollback renders. Ruled on the least-surprise
  // tiebreak; privmsg/notice keep the `<nick> …` shape unchanged.
  const head = msg.kind === "action" ? `* ${msg.sender}` : `<${msg.sender}>`;
  return `${head} ${body}${REPLY_QUOTE_TAIL}`;
}

// Drop the quote into the window's compose box with the caret at the end. A
// no-op for a row with nothing to quote — the gesture still slid and snapped
// back, which is the honest feedback for "armed, but this row has no reply".
export function replyToMessage(
  msg: ScrollbackMessage,
  networkSlug: string,
  channelName: string,
): void {
  const quote = replyQuote(msg);
  if (quote === null) return;
  appendToCompose(networkSlug, channelName, quote);
}
