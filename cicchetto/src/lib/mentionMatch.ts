// Pure mention matcher. Case-insensitive word-boundary match against a
// SINGLE term. The primitive both `matchesWatchlist` (below) and the live
// beep path build on:
//   - matchesWatchlist → ScrollbackPane / MentionsWindow visual highlight
//   - subscribe.ts (live mention ALERT — beep + optimistic badge — on
//     PRIVMSG; #267 moved the mention COUNT server-side, so this drives
//     only the transient alert, not a count)
//
// Same predicate, several consumers — extracted once here so a regex tweak
// (e.g. broader Unicode word-boundary support in M-cluster) lands in
// one place. RFC 2812 nick chars include `[`, `]`, `\` etc.; the regex
// metacharacter escape covers the cases that would otherwise blow up
// the RegExp constructor.

export const mentionsUser = (body: string | null, term: string | null): boolean => {
  if (!body || !term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(body);
};

// The SINGLE client-side "does this line mention me?" predicate:
// own nick ∪ custom highlight patterns (from /hilight, #356), word-boundary
// and case-insensitive. Mirror of the server SSOT
// `Grappa.Mentions.mentioned?/3`.
//
// #370 — this is the one source shared by the in-message VISUAL highlight
// (`ScrollbackPane` `.scrollback-mention` / `.scrollback-highlight`,
// `MentionsWindow`) AND the client notify mirror (`pushTriggers.shouldNotify`).
// Before #370 the visual path only ever received the own nick, so a message
// matching a custom /hilight word fired the (server-side) notification yet
// rendered as a plain line — the notify-match and visual-match had silently
// diverged. Threading `patterns` here re-unifies them: a custom word gets the
// exact same emphasis an own-nick mention gets. `mentionsUser` skips falsy
// terms, so a not-yet-resolved own nick still matches on patterns alone.
export const matchesWatchlist = (
  body: string | null,
  ownNick: string | null,
  patterns: string[],
): boolean => [ownNick, ...patterns].some((term) => mentionsUser(body, term));
