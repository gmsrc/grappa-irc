// Case-insensitive IRC nickname comparison — the SINGLE client-side
// nick fold + equality helper.
//
// ## Two tiers, and which one a call site wants (#525 + #1861)
//
// `asciiFold` is the plain `A-Z` byte fold: the client mirror of the
// server's arity-1 `Grappa.IRC.Identifier.canonical_target/1`.
// `normalizeNick`/`nickEquals` are the NETWORK-AWARE tier: they take the
// casemapping the ircd advertised in 005 and mirror the server's
// `normalize_casemapping/2` ∘ `canonical_target/1` composition, i.e. the
// arity-2 `canonical_target/2` that #537 introduced.
//
// On `:ascii` the two tiers are byte-for-byte identical, so on
// bahamut/Azzurra — all of production — nothing about this file's output
// changed with #1861.
//
// ## Why the network tier had to exist (#1861)
//
// `CASEMAPPING=rfc1459` (solanum, Rizon's plexus/hybrid) declares `{ } | ^`
// the lowercase of `[ ] \ ~`, so `[EWG]-L0VE` and `{ewg}-l0ve` are ONE
// person there. cic folded ASCII-only with no network in scope at all —
// `normalizeNick`/`nickEquals` took a single string — so no call site could
// fold per-network even when it held the network id. The sidebar rendered
// two query windows for one peer and the conversation split.
//
// The fold tables below MIRROR the server's `national_byte/2`; they are not
// re-derived from the RFCs. `nickEquals.test.ts` enumerates them as the
// drift gate, the client twin of the server's own pin test.
//
// ## One fold, pinned to the server (#525) — still true, per tier
//
// Azzurra runs bahamut, which advertises AND implements
// `CASEMAPPING=ascii` — it folds ONLY `A-Z`, leaving `[ ] \ ~` untouched.
// #525 corrected the fold: #121/#364 assumed `CASEMAPPING=rfc1459`
// UNIVERSALLY and ALSO folded `[ ] \ ~` → `{ } | ^`, which OVER-folded on
// bahamut — a `foo[1]` / `foo{1}` pair the ircd keeps DISTINCT collapsed
// onto one key (members dropped a present, talking user from the list when
// their bracket twin quit; DM windows + own-nick checks merged two
// identities). #1861 does NOT reinstate that: the national fold happens
// ONLY when the network said `rfc1459`, and `:ascii` stays `A-Z` only.
//
// Bucket F H3 (retained): pre-fix members.ts and ScrollbackPane.tsx
// used bare `===` for nick comparison, producing phantom member entries
// (server emits `Alice` on JOIN, `alice` on QUIT — the QUIT didn't
// match the JOIN row and `Alice` lingered forever), missed self-JOIN
// banners, and ownModes lookup misses. Per CLAUDE.md "Total
// consistency or nothing" every nick comparison in cic goes through
// this helper.
//
// ## The `asciiFold` sites that deliberately did NOT move (#1861)
//
// A call site keeps the ASCII tier when its other side is a key some OTHER
// component already folded ASCII — folding harder on one end only would
// FORK what agrees today. Named here so a reader greps `asciiFold`, finds
// survivors, and knows they were considered:
//
//   * `channelKey.ts` (`canonicalChannel`) — mirrors the key the SERVER
//     stores and broadcasts. The server DOES normalise channel/DM keys
//     per-network at ingress (#537 axis 2), so this one is a genuine
//     remaining gap rather than a must-stay; it is not fixed here because
//     threading a casemapping through every `channelKey(slug, name)` call
//     is the channel axis this issue scopes out, and getting it half-right
//     is worse than leaving it uniform.
//   * `pushTriggers.ts` — `prefs.private_messages_only` is a SERVER-stored
//     list folded with the arity-1 `Identifier.canonical_target/1`
//     (`user_settings.ex`, `list_fold/1`). cic must fold identically or the
//     client-side push preview disagrees with the server's own trigger.
//   * `notifyWatch.ts` — the presence map keys "arrive server-folded"
//     (`presence_snapshot`); `presenceFor` must reproduce the server's fold,
//     not a better one.
//   * `nickColor.ts` (`djb2(asciiFold(nick))`) — a palette hash, not an
//     identity key. Two spellings of one rfc1459 identity get two colours;
//     that is cosmetic and pinned by an e2e spec.
//   * `pingCorrelation.ts` — correlation keys carry a token/verb as well as
//     the nick, and both ends are built by cic. Same class of gap as
//     `channelKey`, no identity fork.

import type { Casemapping } from "./isupport";

// ASCII-byte-level fold — the client mirror of the server's arity-1
// `Grappa.IRC.Identifier.canonical_target/1`. Folds ONLY `A-Z` by char
// code; `[ ] \ ~` and every multibyte (non-ASCII) sequence pass through
// untouched, byte-for-byte with the server's `fold_ascii_byte/1` (JS
// `toLowerCase()` is Unicode-aware and would over-fold, e.g.
// `CAFÉ`→`café`, forking keys the server keeps distinct).
//
// Callers that hold a network id want `normalizeNick`/`nickEquals`
// instead; this stays exported for the sites listed in the module doc,
// whose counterpart key is ASCII-folded elsewhere.
export const asciiFold = (nick: string): string =>
  nick.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

// The rfc1459 "national character" fold — the client mirror of the
// server's `national_byte/2`. `foldTilde` distinguishes `rfc1459` (folds
// `~`→`^`, the RFC 2812 rule) from `rfc1459_strict` (bracket trio only:
// RFC 1459 predates the tilde rule).
//
// Char-level rather than byte-level, which is the same thing here: all
// four sources are `< 0x80` and JS strings are UTF-16, so a non-ASCII
// code unit can never equal one of them. Idempotent, because the fold
// TARGETS (`{ } | ^`) are not in the source set.
const nationalFold = (nick: string, foldTilde: boolean): string =>
  nick.replace(foldTilde ? /[[\]\\~]/g : /[[\]\\]/g, (c) => {
    switch (c) {
      case "[":
        return "{";
      case "]":
        return "}";
      case "\\":
        return "|";
      default:
        return "^";
    }
  });

/**
 * Fold a nick to its comparison form under `casemapping` — the client
 * mirror of the server's `Identifier.canonical_target/2`.
 *
 * Use directly when storing a nick into a Map/Set keyed for
 * case-insensitive lookup; for binary equality checks prefer
 * `nickEquals`. The casemapping is `casemappingForNetwork(networkId)`
 * (`isupport.ts`) at every store-reading call site, and a plain parameter
 * at the pure ones — the same shape `chantypes.ts` uses for `CHANTYPES=`.
 *
 * Required, not defaulted: a silent `"ascii"` default would let a call
 * site that forgot the network look correct on Azzurra and fork on Rizon,
 * which is precisely the bug this replaced.
 */
export const normalizeNick = (nick: string, casemapping: Casemapping): string => {
  switch (casemapping) {
    case "ascii":
      return asciiFold(nick);
    case "rfc1459":
      return asciiFold(nationalFold(nick, true));
    case "rfc1459_strict":
      return asciiFold(nationalFold(nick, false));
  }
};

/**
 * Case-insensitive nick equality under `casemapping`. Returns false when
 * either side is null or undefined — the existing call sites (members.ts
 * presence dispatch, ScrollbackPane self-banner / ownModes) all guard on
 * non-null nicks at the outer scope; this internal null-safety just makes
 * the helper composable.
 */
export const nickEquals = (
  a: string | null | undefined,
  b: string | null | undefined,
  casemapping: Casemapping,
): boolean => {
  if (a == null || b == null) return false;
  return normalizeNick(a, casemapping) === normalizeNick(b, casemapping);
};
