import type { ScrollbackMessage } from "./api";
import { appendToCompose } from "./composeAppend";
import { quotableBody } from "./quotableBody";

// #1107 — the `!addquote` verb behind the message menu's fourth item. It fills
// the compose box and stops: nothing is sent, and cic does not know or care
// what `!addquote` means. Whatever bot sits in the channel interprets it, and
// the operator gets to read the line before pressing enter.
//
// THE PAYLOAD IS THE BARE BODY. The issue leaves that open ("whether the
// payload is the bare body or carries the nick") because bots differ; it is
// ruled on the requester's literal words — `!addquote` and then the message.
// A wrapper is one line away in either direction, and guessing WIDER is the
// worse guess: a bot that wants attribution can read the nick off the channel,
// while a bot that stores its input verbatim would put `<vjt>` inside every
// stored quote with no way for the operator to know until it is recalled.
export const ADDQUOTE_COMMAND = "!addquote ";

// The command line for a message, or null when the row has nothing to quote —
// the same refusals Reply makes, because they are the same question ("did
// somebody say something here?") and `quotableBody` is where they live.
//
// An ACTION contributes its text without the `* nick` form Reply gives it: the
// payload carries no attribution at all, so half of one for one kind would be
// a shape the operator cannot predict from the menu.
export function addQuoteCommand(msg: ScrollbackMessage): string | null {
  const body = quotableBody(msg);
  return body === null ? null : `${ADDQUOTE_COMMAND}${body}`;
}

// Drop the command into the window's compose box with the caret at the end and
// REVEALED — `!addquote ` plus a body overflows the rows=1 textarea nearly
// every time, which is why #1107 waited on #1105/#1113. `appendToCompose` owns
// that dance; going around it is how the caret got lost the first time.
export function addQuoteToCompose(
  msg: ScrollbackMessage,
  networkSlug: string,
  channelName: string,
): void {
  const command = addQuoteCommand(msg);
  if (command === null) return;
  appendToCompose(networkSlug, channelName, command);
}
