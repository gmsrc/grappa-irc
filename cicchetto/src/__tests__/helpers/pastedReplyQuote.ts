// issue 2156 — the transcript vjt pasted on #grappa (19:21), verbatim, plus
// where the quote it carries ends.
//
// Shared rather than copied into the two files that need it, for the reason
// the fix itself exists: the region the renderer DIMS and the region a requote
// STRIPS are one region, and two tests spelling the same paste slightly
// differently would stop describing the same incident the moment one is
// edited. `replyQuote.test.ts` asserts the offset, `MircText.test.tsx` asserts
// the spans — off the same two constants.
//
// The decorations are the whole point: a leading `HH:MM:SS ` printed by the
// pasting client, and the channel-status sigil inside the wrapper. cic emits
// NEITHER (`replyQuote.ts` builds the quote from the MESSAGE so the row's own
// timestamp and prefix glyph stay out of it), which is why the head the quote
// detector was shaped against never reached this body.
export const PASTED_REPLY_BODY =
  '19:19:22 <@Johnny^Lizard> 19:16:17 <%Sythos> avrei evidenziato "fa finta"... O:) << lol.. cmq succede che ignorano certe istruzioni e devi rimarcarle più volte';

// Through the LAST tail, trailing space included — the paste is itself a
// chain (`<%Sythos>`'s line quoted inside `<@Johnny^Lizard>`'s), so the greedy
// body sheds every hop and not just the outermost one.
export const PASTED_REPLY_HEAD =
  '19:19:22 <@Johnny^Lizard> 19:16:17 <%Sythos> avrei evidenziato "fa finta"... O:) << ';

// What the sender of the pasted line actually wrote.
export const PASTED_REPLY_ANSWER =
  "lol.. cmq succede che ignorano certe istruzioni e devi rimarcarle più volte";
