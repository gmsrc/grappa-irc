// The SINGLE client-side "does this line mention me?" predicate.
//
// The source is ONE list: the operator's watchlist = own nick ∪ the custom
// /hilight keyword list (#356). The own nick is just ANOTHER ENTRY in that
// list, NOT a special case — every term is matched the same way (word-boundary,
// case-insensitive). Mirror of the server SSOT `Grappa.Mentions.mentioned?/3`.
//
// #370 — ONE predicate feeds EVERY client sink so notify-match and
// visual-match can never diverge again:
//   - in-message visual highlight (ScrollbackPane `.scrollback-mention` /
//     `.scrollback-highlight`, MentionsWindow),
//   - the live in-app beep + optimistic desktop-title bump (subscribe.ts),
// and is kept in parity with the client push mirror (pushTriggers.shouldNotify,
// a drift-guard tested against the shared server truth-table, no live caller).
// The server owns the remaining sinks (OS push + sidebar count) via the same
// `mentioned?/3` source. Before #370 the visual path and the live beep only
// ever matched the own nick, so a /hilight word fired the (server-side)
// notification yet rendered plain and stayed silent — the paths had forked.
//
// `matchesTerm` (private) is the per-term word-boundary primitive; it skips
// falsy terms, so a not-yet-resolved own nick still matches on patterns alone.
// RFC 2812 nick chars include `[`, `]`, `\` etc.; the regex metacharacter
// escape covers the cases that would otherwise blow up the RegExp constructor.

import { isServerSender, isServicesSender } from "./servicesSender";

// #1786 — the anchor is conditional on the term's OWN edge, and that is a fix
// rather than a loosening.
//
// `\b` is a TRANSITION between a word char and a non-word one, so it is only
// satisfiable on a side where the term's edge character IS a word char. Wrapped
// unconditionally, a term like `QUACK!` demanded a word character immediately
// after the `!` — end-of-line and a space both fail it, so the term could never
// match anything. Found in prod as a whole watchlist of trailing-`!` terms the
// settings pane listed as active while they silently matched nothing.
//
// The lookarounds say what `\b` was always meant to say on those edges: "not
// glued to a word". They are NOT the same as dropping the anchor — `!list` must
// still refuse `foo!list` — which is the pair of cases the test file calls
// discriminating.
//
// The probe is a regex over the RAW term rather than a character-class literal
// so that it consults the SAME `\w` the anchor will: one definition, no second
// spelling to drift from it. Mirror of `Grappa.Mentions.build_matchers/1`; a
// change here lands in both ports together, per this module's header.
const termAnchors = (term: string): { readonly prefix: string; readonly suffix: string } => ({
  prefix: /^\w/.test(term) ? "\\b" : "(?<!\\w)",
  suffix: /\w$/.test(term) ? "\\b" : "(?!\\w)",
});

const matchesTerm = (body: string | null, term: string | null): boolean => {
  if (!body || !term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const { prefix, suffix } = termAnchors(term);
  return new RegExp(`${prefix}${escaped}${suffix}`, "i").test(body);
};

export const matchesWatchlist = (
  body: string | null,
  ownNick: string | null,
  patterns: string[],
): boolean => [ownNick, ...patterns].some((term) => matchesTerm(body, term));

// #1674 — the SENDER half of the mention rule. Mirror of
// `Grappa.Mentions.mentionable_sender?/1`: being told something by a robot
// is not being mentioned by somebody. A NickServ login confirmation and the
// ircd's connect notices both spell your nick as a matter of routine, and
// on the server that lit the highest-severity badge grappa has.
//
// Keyed on the SENDER, not the kind: a human `/notice` IS conversation and
// still counts. Biased toward `true` — it only ever SUBTRACTS, so an empty
// sender stays mentionable and the other conjuncts decide it.
export const isMentionableSender = (sender: string): boolean =>
  !isServicesSender(sender) && !isServerSender(sender);
