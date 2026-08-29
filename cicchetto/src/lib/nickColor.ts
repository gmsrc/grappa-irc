import type { Casemapping } from "./isupport";
import type { ChannelMembers } from "./memberTypes";
import { asciiFold, nickEquals } from "./nickEquals";

// UX-5 bucket BC2 — colored nicks (xchat-style) + scrollback-side
// mode-prefix glyph lookup.
//
// Two concerns, ONE module (per CLAUDE.md "implement once, reuse
// everywhere"; the render-side consumers always need BOTH the color
// and the prefix for a given (channel, nick) pair, and bundling here
// avoids two parallel import chains across the ~13 render sites).
//
// ## Colored nicks
//
// Each nick maps to a deterministic palette index via the djb2 hash
// (https://theartincomputerprogramming.com/djb2). djb2 chosen over
// fnv1a for two reasons: (1) ~5-line implementation that fits in
// the head; (2) decades of irc-client precedent (xchat/hexchat use
// the same idea — they vary the multiplier but not the structure).
//
// Hash input is the ASCII-FOLDED nick (`asciiFold`, the ONE client
// fold shared with the nick-identity layer and a faithful mirror of the
// server's `Grappa.IRC.Identifier.canonical_nick/1`): bahamut is
// CASEMAPPING=ascii (#121/#525), so the fold touches `A-Z` ONLY. Case
// variants like `Vjt`/`vjt` are the same operator and MUST hash to the
// same color; `[ ] \ ~` are NOT folded, so `Foo[1]` and `foo{1}` are
// DISTINCT identities that hash independently (#525 reverted #364's
// bracket over-fold). `asciiFold` is preferred over a bare `toLowerCase`
// because `toLowerCase` Unicode-OVER-folds non-ASCII (`CAFÉ`→`café`),
// forking the identity layer; it does NOT touch the brackets. (Pre-#412
// nick colors used their own `toLowerCase`, a separate fold policy from
// the identity layer, since consolidated onto the shared primitive.)
// Bucket count is `NICK_PALETTE_SIZE` (32) — but the theme AUTHORS only
// 16 hues. #444: a busy channel shows more than 16 nicks at once, so at
// 16 buckets same-color collisions are a pigeonhole CERTAINTY (measured:
// ~13.75 distinct colors at a 30-nick roster). The palette is the
// ceiling, not the hash — no stateless per-nick function can beat 16
// colors with 16 buckets. Doubling to 32 halves the collision rate.
//
// The 16 hand-picked xchat-style hues (`nick_0..15`) ARE the project
// aesthetic and the closed server theme-token vocabulary
// (`Grappa.Themes.TokenModel`, the theme editor, every saved DB theme).
// Widening THAT would be a server contract change + a data migration
// (COLD). Instead cic DERIVES buckets 16..31 from the theme's own 16 — a
// tone shift toward `--fg` expressed in CSS `color-mix` (see
// `themes/default.css`) — so the render palette is 32 while the server
// stays at 16 tokens: cic-only, no migration, zero server change.
//
// Undefined-var safety (the thing that would break on a legacy theme):
// `NickText` renders `color: var(--nick-color-N)` with NO fallback, so a
// bucket with no `--nick-color-N` declaration is invalid-at-computed-
// value-time and the nick silently inherits `--fg` (uncolored). The
// derived 16..31 are therefore declared in the STYLESHEET (NOT set from
// the JS token→var map, which only writes the payload's 16 keys) as
// `color-mix(... var(--nick-color-k) ...)`. A custom theme overrides
// `--nick-color-0..15` INLINE; the derived rule references them via
// `var()`, so it recomputes against the active theme's colors — even a
// legacy 16-key custom theme gets correct 16..31, never an undefined var.
//
// Hash honesty at 32: djb2 mod 32 keeps the SAME documented degeneracies
// as mod 16 — 33 ≡ 1 (mod 32) so letter ORDER is invisible (anagrams
// share a bucket), and the ASCII case shift (`A-Z`, ±32) is ≡ 0
// (mod 32) so case-folding is output-invisible here too. Per #444 the
// hash is NOT the problem (its distribution was measured fine) and must
// not eat a commit; the win is the doubled COLOR count via derivation.
// Folding is still correct-by-construction (case variants `Foo[1]`/
// `foo[1]` fold to one string → one index at ANY N; `[ ] \ ~` are NOT
// folded post-#525, so `Foo[1]`/`foo{1}` are distinct and hash
// independently — the #412/#525 regression tests pin both).
//
// Theme-aware by construction: the helper produces a `var(--nick-color-N)`
// string; the theme (or the derived rule) owns the hue. Switching themes
// re-renders the same nicks in a new palette without touching this module.
//
// ## Scrollback sender prefix
//
// Members-pane nicks already carry the prefix via `memberSigil`
// (op `@`, halfop `%`, voiced `+`, plain ` `). Scrollback PRIVMSG
// senders are bare `{nick}` interpolations — no per-message mode
// flag on the wire (scrollback `messages` table is mode-agnostic;
// modes belong to the live members store). The `senderPrefix`
// helper looks up the CURRENT membership for (channel, nick) and
// returns the highest-precedence prefix glyph for inline render in
// `<sender>` / `*sender` lines.
//
// Returns empty string `""` (not " ") for plain / unknown members:
// scrollback senders live inside `<...>` brackets and any space
// would render as `< nick>` with a visible gap. The members-pane
// padding-space (`memberSigil` returns " ") only makes sense in a
// column layout where prefix-aligned glyphs share width.

export const NICK_PALETTE_SIZE = 32;

// djb2 hash, classic 5381 seed + 33 multiplier. Folded modulo
// NICK_PALETTE_SIZE at the boundary; intermediate keeps full 32-bit
// width via Math.imul to avoid sign-bit weirdness from `* 33`.
//
// #1861 — deliberately still `asciiFold`, NOT the per-network
// `normalizeNick`. This is a palette hash, not an identity key: on an
// rfc1459 network `Foo[1]` and `foo{1}` are one person and get two
// colours, which is cosmetic. Making it network-aware would need the
// network id at every render site and would re-colour existing rows
// (the `ux-5-bc2-nick-render` e2e spec pins `djb2(asciiFold(nick))`),
// for no identity correctness. See the survivor list in `nickEquals.ts`.
export const nickColorIndex = (nick: string): number => {
  const folded = asciiFold(nick);
  let hash = 5381;
  for (let i = 0; i < folded.length; i++) {
    hash = (Math.imul(hash, 33) + folded.charCodeAt(i)) | 0;
  }
  // `>>> 0` coerces to unsigned 32-bit so the modulo is always
  // non-negative — `-1 % NICK_PALETTE_SIZE` is `-1` in JS, which would
  // slot us outside the palette.
  return (hash >>> 0) % NICK_PALETTE_SIZE;
};

export const nickColorVar = (nick: string): string => `var(--nick-color-${nickColorIndex(nick)})`;

// Highest-precedence channel-mode prefix glyph for a (members, nick)
// pair. Mirrors the precedence in `memberSigil` (@ > % > +) — both
// derive from the same `MemberEntry.modes` array, just diverge on
// what to return for the plain case.
export const senderPrefix = (
  members: ChannelMembers | undefined,
  nick: string,
  casemapping: Casemapping,
): "@" | "%" | "+" | "" => {
  if (!members) return "";
  const entry = members.find((m) => nickEquals(m.nick, nick, casemapping));
  if (!entry) return "";
  if (entry.modes.includes("@")) return "@";
  if (entry.modes.includes("%")) return "%";
  if (entry.modes.includes("+")) return "+";
  return "";
};

// #25: glyph for a CONTENT row's own sender, read from the server's
// send-time snapshot (`meta.sender_prefix`) instead of live member
// state. The server captures the sender's grade at persist time so a
// later MODE change can't retroactively re-prefix old lines. Returns ""
// when the snapshot is absent — a plain sender, or a row persisted
// before #25 landed — so cic never falls back to a live-derived guess
// (which is exactly the bug). `meta` is the untyped wire bag, so the
// value is validated against the three glyphs here.
export const snapshotSenderPrefix = (meta: Record<string, unknown>): "@" | "%" | "+" | "" => {
  const p = meta.sender_prefix;
  return p === "@" || p === "%" || p === "+" ? p : "";
};
