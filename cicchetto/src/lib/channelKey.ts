// Composite key for the (network, channel) pair, used as the index
// into per-channel signal stores (`scrollback.ts`, `selection.ts`,
// `subscribe.ts`). Shared infrastructure — no behaviour, no state —
// lifted out of the original `networks.ts` god-module so every per-
// channel store can import the brand without depending on each other.
//
// Composite key shape: `${networkSlug} ${channelName}`. Space is forbidden
// in IRC channel names (RFC 2812 chanstring excludes 0x20) so it can't
// collide with payload bytes. NUL would also work; space wins because
// it's readable in debugger output and operator log lines.
//
// Opaque-branded type. The `unique symbol` brand makes `ChannelKey`
// distinct from `string` at the type level — a bare network slug or
// channel name passed where a ChannelKey is expected is a compile
// error. The brand is declaration-only (no runtime representation), so
// a ChannelKey is just a string at runtime; only `channelKey(slug, name)`
// builds one. The earlier `${string} ${string}` template-literal form
// looked like a constraint but actually erased to `string` in the type
// system — both ends were unconstrained.

import { asciiFold } from "./nickEquals";

declare const channelKeyBrand: unique symbol;
export type ChannelKey = string & { readonly [channelKeyBrand]: true };

export const channelKey = (slug: string, name: string): ChannelKey =>
  `${slug} ${canonicalChannel(name)}` as ChannelKey;

// ASCII canonicalisation for any Grappa identifier KEY — a channel OR a
// DM-peer nick. Faithful mirror of `Grappa.IRC.Identifier.canonical_target/1`
// on the server: bahamut (CASEMAPPING=ascii, #525) folds ONLY `A-Z`,
// leaving `[ ] \ ~` untouched, and folds channels the SAME way it folds
// nicks — so this is the plain byte-level `asciiFold` on the WHOLE
// identifier. A sigil (`# & ! +`) sits outside `A-Z` and passes through,
// so `canonicalChannel("#Chan") === "#chan"` and a nick folds identically.
//
// #537 CONTRACT CHANGE — this used to be sigil-gated (folded only names
// starting with `# & ! +`, returning nicks RAW), the twin of the server's
// then-sigil-gated `canonical_channel/1`. INC-3 collapsed the server's
// `canonical_channel/1` AND `canonical_nick/1` into one unconditional
// `canonical_target/1`, so the DM window KEY now folds `A-Z` server-side.
// The client mirror MUST fold nick KEYS in lockstep, or a mixed-case DM
// window (`/q Guest`) keys/subscribes on `channel:Guest` while the server
// persists+broadcasts on the folded `channel:guest` — the live DM never
// renders (the regression #537's own e2e caught). The ORIGINAL casing is
// NOT lost: it survives for DISPLAY via the raw `qw.targetNick` (Sidebar /
// BottomBar `<NickText>`) and on the WIRE via the raw send target — this
// function feeds KEYS only (never a shown label or an upstream frame).
//
// #525 posture holds for both shapes: only `A-Z` folds, so `#chan[1]`/
// `#chan{1}` AND `foo[1]`/`foo{1}` stay DISTINCT. A bare `toLowerCase`
// would Unicode-over-fold non-ASCII (`#CAFÉ` → `#café`); `asciiFold` is
// byte-level so those stay distinct too.
//
// Applied at every identifier-KEY cic boundary: `channelKey(slug, name)`
// (composite key), `joinChannel(...)` (Phoenix Channel topic segment),
// REST endpoint URL path-segment producers, and per-channel KEY matches
// (push triggers, banlist, invite-ack). Without it, a mixed-case
// channel/nick from typed input forks a duplicate window beside the folded
// one the server canonicalises to in scrollback + window_state.
export function canonicalChannel(name: string): string {
  return asciiFold(name);
}

// Codebase audit cic M4 — paired decoder for the composite key. Pre-
// fix, `Sidebar.pseudoChannelsForNetwork` and the `subscribe.ts`
// pending-channel pre-subscribe loop both open-coded the parsing
// (`key.startsWith(prefix) + key.slice(prefix.length)` /
// `key.indexOf(" ") + slice` respectively). Two open-coded sites = if
// the key shape ever changes (NUL separator, JSON tuple, branded
// struct), three places update independently. The encoder is the
// single source of truth for shape; the decoder MUST be paired with
// it. Future shape change → both sites update via this decoder only.
//
// Returns `null` if the input doesn't look like a valid composite key
// (no separator). Callers (Sidebar / subscribe.ts loop) treat null as
// "skip this entry" — windowStateByChannel keys SHOULD always be
// well-formed because they originated via `channelKey(...)`, but the
// guard keeps the decoder pure and lets the type system shrug.
export function decodeChannelKey(key: ChannelKey): { slug: string; name: string } | null {
  const sepIdx = key.indexOf(" ");
  if (sepIdx < 0) return null;
  return { slug: key.slice(0, sepIdx), name: key.slice(sepIdx + 1) };
}
