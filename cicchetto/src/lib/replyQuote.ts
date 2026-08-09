import { isContentKind, type ScrollbackMessage } from "./api";
import { appendToCompose } from "./composeAppend";
import { stripCtcpAction } from "./ctcpAction";
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

// #1123 — the nick charset, mirrored from the server's
// `Grappa.IRC.Identifier` `@nick_regex` (RFC 2812 §2.3.1: first char is
// letter-or-special, the tail adds digits and `-`, 30 chars total). Derived
// rather than invented: a narrower guess would refuse to strip a real
// `<foo[1]> ` head, and a wider one starts eating ordinary prose.
const NICK = "[A-Za-z\\[\\]\\\\`_^{|}][\\w\\[\\]\\\\`_^{|}-]{0,29}";

// A previous reply-quote sitting at the head of a body. Anchored at position 0
// and shaped like what THIS module emits — `<nick> ` for speech, `* nick ` for
// an action (#1126) — because a bare `<<` search would eat ordinary text
// (`shift << 2`, `cat <<EOF`), which is worse than the nesting it fixes.
//
// `[\s\S]*` is greedy on purpose: the cut lands on the LAST tail, so a body
// persisted before this fix sheds every hop it accumulated, not just the
// oldest. The tail also counts flush against the end of the body — a sender
// whose whole message was a quote wrote nothing of their own.
const PREVIOUS_QUOTE = new RegExp(`^(?:<${NICK}>|\\* ${NICK}) [\\s\\S]*<<(?: |$)`);

// What the sender actually wrote: their body minus the quote they were
// answering. Returns the body untouched when it is not quote-shaped.
function withoutPreviousQuote(body: string): string {
  return body.replace(PREVIOUS_QUOTE, "").trim();
}

// The quote for a message, or null when there is nothing to reply to.
//
// Only CONTENT kinds quote (`isContentKind` — privmsg/notice/action, the same
// classifier the unread/badge math uses). A presence row is not somebody
// speaking: a PART carries a reason in `body`, so a bare body check would
// happily quote `<vjt> Leaving<< `.
export function replyQuote(msg: ScrollbackMessage): string | null {
  if (!isContentKind(msg.kind)) return null;
  if (msg.sender === "") return null;
  // #1126 — an action's stored body is the raw `\x01ACTION …\x01` wire form.
  // Unwrap it FIRST, with the same helper the render layer uses, so the quote
  // holds the text the operator actually saw. `mircPlainText` deliberately
  // leaves \x01 alone (its call sites need the envelope to round-trip), so
  // stripping there would have been the wrong door.
  const raw = msg.kind === "action" ? stripCtcpAction(msg.body) : (msg.body ?? "");
  // The wire body can carry mIRC control bytes (\x02 bold, \x03 colour…). The
  // operator is quoting what they SEE, and a control byte round-tripped through
  // compose would be re-sent as formatting they never chose.
  // #1123 — the body being quoted may itself be a reply, carrying its own
  // quote plus the `<< ` tail. Left in, every hop drags the whole history
  // forward and the line actually being answered ends up buried mid-string.
  // Dropping it can empty the body: a sender whose message was nothing but a
  // quote said nothing to reply to, which the check below already refuses.
  const body = withoutPreviousQuote(mircPlainText(raw).trim());
  if (body === "") return null;
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
