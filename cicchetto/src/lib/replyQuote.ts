import { isContentKind, type ScrollbackMessage } from "./api";
import { appendToCompose } from "./composeAppend";
import { mircPlainText } from "./mircFormat";

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
// Only CONTENT kinds quote (`isContentKind` — privmsg/notice/action, the same
// classifier the unread/badge math uses). A presence row is not somebody
// speaking: a PART carries a reason in `body`, so a bare body check would
// happily quote `<vjt> Leaving<< `.
export function replyQuote(msg: ScrollbackMessage): string | null {
  if (!isContentKind(msg.kind)) return null;
  if (msg.sender === "") return null;
  // The wire body can carry mIRC control bytes (\x02 bold, \x03 colour…). The
  // operator is quoting what they SEE, and a control byte round-tripped through
  // compose would be re-sent as formatting they never chose.
  const body = mircPlainText(msg.body ?? "").trim();
  if (body === "") return null;
  return `<${msg.sender}> ${body}${REPLY_QUOTE_TAIL}`;
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
