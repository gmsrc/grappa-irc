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

const matchesTerm = (body: string | null, term: string | null): boolean => {
  if (!body || !term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(body);
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
