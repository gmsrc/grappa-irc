import { isContentKind, type ScrollbackMessage } from "./api";
import { stripCtcpAction } from "./ctcpAction";
import { mircPlainText } from "./mircFormat";

// What a scrollback row contributes to a quote: the words its sender actually
// wrote, as the operator SAW them, or null when the row has nothing to quote.
//
// #1107 — lifted out of `replyQuote` when the `!addquote` item needed the same
// answer with a different wrapper. Every clause below is a ruling that took an
// issue to reach (#1067's presence gate, #1123's nesting cut, #1126's CTCP
// unwrap); copying them into a second module would be copying five bugs'
// worth of history and would let the two doors drift apart on the next one.
//
// The WRAPPER is the caller's business — `replyQuote` puts a `<nick> …<< `
// around this, `addQuoteCommand` puts `!addquote ` in front of it. The
// ATTRIBUTION is not: since #1264 both doors head the quote the same way, so
// `attributionHead` lives here with the body it heads.
//
// issue 2033 added the one axis on which the two heads DIFFER — a bridge relay
// is mentioned by Reply and left wrapped by the archive — as a parameter and
// not a fork, because WHO spoke is the same question at both doors and only
// how to spell them changes.

// #1123 — the nick charset, mirrored from the server's
// `Grappa.IRC.Identifier` `@nick_regex` (RFC 2812 §2.3.1: first char is
// letter-or-special, the tail adds digits and `-`, 30 chars total). Derived
// rather than invented: a narrower guess would refuse to strip a real
// `<foo[1]> ` head, and a wider one starts eating ordinary prose.
const NICK = "[A-Za-z\\[\\]\\\\`_^{|}][\\w\\[\\]\\\\`_^{|}-]{0,29}";

// issue 2156 — the channel-status sigil a client prints INSIDE the wrapper
// (`<@Johnny^Lizard>`). Not a nick character: RFC 2812's specials are
// ``[]\`_^{|}`` and none of these five is among them, so the sigil can never be
// read as the nick itself and admitting it costs no ambiguity. Deliberately
// WIDER than cic's own `MODE_PREFIX_TABLE` (`@%+`, the ohv we model): the paste
// comes from somebody else's client on somebody else's network, where `~`
// (founder) and `&` (admin) are printed too.
const STATUS_SIGIL = "[@%+~&]?";

// issue 2156 — the clock a client prints in front of the line. `HH:MM`, with
// optional seconds and a one-digit hour, and the separating space INSIDE the
// group so the whole thing is absent-or-complete.
//
// This is the entire list, and the narrowness is the point. A bracketed
// `[HH:MM]`, a leading date, and irssi's padded `<    nick>` are each another
// client's dialect, none was reported, and a head that accepts anything in
// front of a `<<` is how `shift << 2` becomes a quote again.
const PASTED_TIMESTAMP = "(?:\\d{1,2}:\\d{2}(?::\\d{2})? )?";

// A previous reply-quote sitting at the head of a body. Anchored at position 0
// and shaped like what `replyQuote` emits — `<nick> ` for speech, `* nick ` for
// an action (#1126) — because a bare `<<` search would eat ordinary text
// (`shift << 2`, `cat <<EOF`), which is worse than the nesting it fixes.
//
// issue 2156 widened the HEAD and only the head, with the two optional groups
// above. WHY the head and not the shape: cic never emits either decoration
// (`replyQuote` builds the quote from the MESSAGE precisely so the row's
// timestamp and prefix glyph stay out of it), so this regex was never too
// narrow by accident — it was exactly as narrow as what WE produce, and a
// quote another client pasted carries two things we do not. The nick wrapper
// stays MANDATORY: a timestamp alone does not make a quote.
//
// `[\s\S]*` is greedy on purpose: the cut lands on the LAST tail, so a body
// persisted before this fix sheds every hop it accumulated, not just the
// oldest. The tail also counts flush against the end of the body — a sender
// whose whole message was a quote wrote nothing of their own.
const PREVIOUS_QUOTE = new RegExp(
  `^${PASTED_TIMESTAMP}(?:<${STATUS_SIGIL}${NICK}>|\\* ${NICK}) [\\s\\S]*<<(?: |$)`,
);

// What the sender actually wrote: their body minus the quote they were
// answering. Returns the body untouched when it is not quote-shaped.
function withoutPreviousQuote(body: string): string {
  return body.replace(PREVIOUS_QUOTE, "").trim();
}

// issue 2033 — a BRIDGE relays somebody else's words under its own IRC nick and
// wraps the real author into the body: `<Gazzurbo> <THREADelli> ne parlavamo…`.
// `msg.sender` is then the RELAY. Quoting it names a bot, buries the person
// being answered, and reaches the far side three attributions deep.
//
// Detection is the head shape ALONE — vjt's ruling (2026-09-10): no configured
// relay list, no gating on anything else. `(?: |$)` rather than a bare space
// because the body arrives `.trim()`ed, so a relay line whose author said
// nothing (`<THREADelli> `) has already lost the space that would anchor it;
// the same idiom `PREVIOUS_QUOTE` uses for its own tail.
const BRIDGE_RELAY_HEAD = new RegExp(`^<(${NICK})>(?: |$)`);

// How a RECOVERED author is spelled. The two doors diverge here and nowhere
// else (vjt's ruling 4): a reply MENTIONS them, because `@nick` is what makes
// the far side notify a person; an archive addresses nobody and so keeps them
// WRAPPED, exactly as the scrollback rendered them.
export type RelayedAuthorStyle = "mention" | "wrapped";

// Who spoke, and what is left of what they said. One pass, because the head
// the caller emits and the head the body sheds are the same finding — asking
// the question twice is how the two doors would come to disagree about what a
// relay looks like.
//
// THE ORDER OF THE TWO PEELS IS FORCED, not a preference. #1123's cut runs
// FIRST: a plain reply body (`<bob> original<< answer`) opens with a nick
// wrapping too, so looking for a relay first would recover `bob` — who is being
// QUOTED, not speaking — and strand the rest past a cut that no longer matches.
//
// An ACTION is never read as bridged, and that is a decision the rulings did
// not cover: #1126 forbids rendering an action as speech, and `!addquote`
// shares this detection, so it would archive `<THREADelli> waves` as something
// nobody said. No transcript of an action-shaped relay exists; this falls back
// to today's behaviour, the same bounded silence rulings 1 and 3 accept.
function attributed(msg: ScrollbackMessage): { author: string | null; body: string } {
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
  const body = withoutPreviousQuote(mircPlainText(raw).trim());
  if (msg.kind === "action") return { author: null, body };
  const relay = BRIDGE_RELAY_HEAD.exec(body);
  if (relay === null) return { author: null, body };
  return { author: relay[1] ?? null, body: body.slice(relay[0].length).trim() };
}

// How far a quote-shaped head reaches into `text`, in UTF-16 units, or 0 when
// the text is not quote-shaped. The count INCLUDES the tail's trailing space,
// so `text.slice(headLength)` is exactly what `withoutPreviousQuote` keeps.
//
// issue 2086 — the RENDER dims that head, and it must dim the same region a
// re-reply strips: a second detector would let the two drift, and then the
// colour on screen would be describing a boundary the requote does not use.
// The offset is the general answer here — a boolean cannot say WHERE — so the
// two doors below are one `exec` and its `> 0`, never two regexes.
export function replyQuoteHeadLength(text: string): number {
  return PREVIOUS_QUOTE.exec(text)?.[0].length ?? 0;
}

// #1688 — the same question asked of a COMPOSE DRAFT rather than of a wire
// body: does this string already open with a quote WE emitted?
//
// Shares `PREVIOUS_QUOTE` rather than re-deriving it, because the trap is
// identical on both sides and it is the trap this regex exists for: a bare
// `<<` search calls `shift << 2` a quote, and on the draft side that
// mis-classification is what decides whether the operator's own sentence gets
// reordered. One nick charset, one anchor, one answer.
//
// issue 2156 therefore moved this door too, and the change is deliberate: a
// draft the operator PASTED from another client used to read as their own text
// and take the new quote in FRONT, and now reads as quote-shaped and takes it
// behind. Sharing the predicate is what makes the three doors agree on what a
// quote looks like; splitting it here to keep the old ordering would mean the
// renderer dimming a head the compose box says is not one.
export function startsWithReplyQuote(text: string): boolean {
  return replyQuoteHeadLength(text) > 0;
}

// Only CONTENT kinds quote (`isContentKind` — privmsg/notice/action, the same
// classifier the unread/badge math uses). A presence row is not somebody
// speaking: a PART carries a reason in `body`, so a bare body check would
// happily quote `Leaving`.
export function quotableBody(msg: ScrollbackMessage): string | null {
  if (!isContentKind(msg.kind)) return null;
  if (msg.sender === "") return null;
  // Dropping the previous quote — or the relay head (issue 2033) — can empty
  // the body: a sender whose message was nothing but a quote said nothing to
  // quote back, and a relay line with nothing past the wrapping is nobody
  // saying anything.
  const { body } = attributed(msg);
  return body === "" ? null : body;
}

// How the row names its sender, in the form the SCROLLBACK RENDERS it: `<nick>`
// for speech, `* nick` for an action.
//
// #1126 ruled it for Reply — quoting `* vjt waves` as `<vjt> waves` puts a
// sentence in someone's mouth they never said. #1264 gave `!addquote` the same
// heads, on the same principle stated from the other side: what gets quoted is
// what the operator READ. Shared rather than written twice because the two
// doors are now one rule, and a copy would let the next kind be added to one of
// them only.
//
// issue 2033 — when the row turns out to be a BRIDGE relay, the head names the
// author the relay wrapped instead of the relay itself, spelled per `style`.
// This stayed one function on purpose: the two doors differ by that parameter
// and by nothing else, so neither can drift on WHAT a relay is.
export function attributionHead(msg: ScrollbackMessage, style: RelayedAuthorStyle): string {
  const { author } = attributed(msg);
  if (author !== null) return style === "mention" ? `@${author}` : `<${author}>`;
  return msg.kind === "action" ? `* ${msg.sender}` : `<${msg.sender}>`;
}
