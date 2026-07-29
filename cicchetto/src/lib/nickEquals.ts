// Case-insensitive IRC nickname comparison — the SINGLE client-side
// nick fold + equality helper.
//
// ## One fold, pinned to the server (#525)
//
// Azzurra runs bahamut, which advertises AND implements
// `CASEMAPPING=ascii` — it folds ONLY `A-Z`, leaving `[ ] \ ~`
// untouched. The server's single source of truth is
// `Grappa.IRC.Identifier.canonical_nick/1` (byte-level ASCII).
// `asciiFold` below is the ONE client mirror of that fold;
// `normalizeNick` and `nickEquals` are layered on it so the whole cic
// codebase folds nicks exactly as the server does — no two-policy drift
// class. `nickEquals.test.ts` enumerates the fold table as a drift gate.
//
// #525 corrected the fold: #121/#364 assumed `CASEMAPPING=rfc1459` and
// ALSO folded `[ ] \ ~` → `{ } | ^`, which OVER-folded — a `foo[1]` /
// `foo{1}` pair the ircd keeps DISTINCT collapsed onto one key (members
// dropped a present, talking user from the list when their bracket twin
// quit; DM windows + own-nick checks merged two identities). The fold
// now matches the ircd exactly: `A-Z` only.
//
// Bucket F H3 (retained): pre-fix members.ts and ScrollbackPane.tsx
// used bare `===` for nick comparison, producing phantom member entries
// (server emits `Alice` on JOIN, `alice` on QUIT — the QUIT didn't
// match the JOIN row and `Alice` lingered forever), missed self-JOIN
// banners, and ownModes lookup misses. Per CLAUDE.md "Total
// consistency or nothing" every nick comparison in cic goes through
// this helper.

// ASCII-byte-level fold — the single client mirror of
// `Grappa.IRC.Identifier.canonical_nick/1`. Folds ONLY `A-Z` by char
// code (bahamut is `CASEMAPPING=ascii`, #525); `[ ] \ ~` and every
// multibyte (non-ASCII) sequence pass through untouched, byte-for-byte
// with the server's `fold_ascii_byte/1` (JS `toLowerCase()` is
// Unicode-aware and would over-fold, e.g. `CAFÉ`→`café`, forking keys
// the server keeps distinct).
export const asciiFold = (nick: string): string =>
  nick.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

// Normalize a nick to its case-folded comparison form. Use directly
// when storing a nick into a Map/Set keyed for case-insensitive lookup;
// for binary equality checks prefer `nickEquals`.
export const normalizeNick = (nick: string): string => asciiFold(nick);

// Case-insensitive nick equality. Returns false when either side is
// null or undefined — the existing call sites (members.ts presence
// dispatch, ScrollbackPane self-banner / ownModes) all guard on
// non-null nicks at the outer scope; this internal null-safety just
// makes the helper composable.
export const nickEquals = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (a == null || b == null) return false;
  return normalizeNick(a) === normalizeNick(b);
};
