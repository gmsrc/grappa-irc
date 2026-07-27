import type { ChannelMembers } from "./memberTypes";
import { nickEquals, rfc1459Fold } from "./nickEquals";

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
// Hash input is the rfc1459-FOLDED nick (`rfc1459Fold`, the ONE client
// fold shared with the nick-identity layer and a faithful mirror of the
// server's `Grappa.IRC.Identifier.canonical_nick/1`): `Vjt`/`vjt` AND
// `Foo[1]`/`foo{1}` are the same operator to bahamut, so they must hash
// to the same color. (Pre-#412 this used a bare `toLowerCase`, which
// leaves `[ ] \ ~` unfolded — harmless ONLY because at the current
// palette size the fold happens to be invisible: see below. It is a
// separate fold policy from the identity layer and was consolidated.)
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
// share a bucket), and every rfc1459 shift (`A-Z`, `[ ] \ ~`) is ±32 ≡ 0
// (mod 32) so the fold is output-invisible here too. Per #444 the hash is
// NOT the problem (its distribution was measured fine) and must not eat a
// commit; the win is the doubled COLOR count via derivation. Folding is
// still correct-by-construction (`Foo[1]`/`foo{1}` fold to one string →
// one index at ANY N; the #412 regression test pins it).
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
export const nickColorIndex = (nick: string): number => {
  const folded = rfc1459Fold(nick);
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
): "@" | "%" | "+" | "" => {
  if (!members) return "";
  const entry = members.find((m) => nickEquals(m.nick, nick));
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
