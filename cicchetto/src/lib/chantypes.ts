// #1255 — the channel sigil class: which characters open a CHANNEL name
// rather than a nick. Per-network truth, advertised by the ircd in the 005
// `CHANTYPES=` token.
//
// ## Why this is a module of its own
//
// The RFC 2812 class was open-coded as a regex in `compose.ts`,
// `slashCommands.ts` and `ScrollbackPane.tsx`, each with its own copy,
// because the correct source never reached the client: the server parsed
// six 005 tokens and shipped two. `compose.ts` said so in a comment. Now
// that `isupport_changed` carries `chantypes`, those copies read the
// advertised set — and this module is where the fact and the test live.
//
// It holds no state and imports nothing, so the PURE parser
// (`slashCommands.ts`, which deliberately has no imports at all) can use it
// without taking a dependency on the solid-js capability store. The
// store-reading half — "what did THIS network advertise?" — lives in
// `isupport.ts` as `chantypesForNetwork`, which is the only place that
// needs a network id.
//
// ## Two copies of these bytes survive elsewhere, deliberately
//
//   * `inviteLink.ts` pins `#&+!` for URL-ENCODING reasons (a literal `#`
//     truncates a query param at the fragment, `&` starts the next param),
//     and it runs on the `?go=` boot path before any session exists — there
//     is no network to ask.
//   * `pushPayload.ts` runs inside the service worker, which has no store,
//     no socket and no session. Its sigil scan classifies a notification
//     deep-link, and it must keep working with the SPA closed.
//
// Neither is a per-network IRC fact rendered from a guess; both are
// context-free byte constraints. They are named here so a future reader
// greps `#&+!`, finds two survivors, and knows they were considered.

// The RFC 2812 class, and the pre-005 default: what every open-coded copy
// assumed, so a network that advertises no CHANTYPES behaves exactly as cic
// behaved before the widening.
export const DEFAULT_CHANTYPES: readonly string[] = ["#", "&", "+", "!"];

/**
 * Whether `name` opens with one of `chantypes` — the network-advertised
 * answer to "channel or nick?".
 *
 * Takes the sigils as DATA so the pure parsers stay pure and can be tested
 * against a network that publishes something other than the RFC class. On a
 * network advertising `CHANTYPES=#`, `&foo` is a nick, and offering it as a
 * channel builds a JOIN the ircd will refuse.
 */
export function isChannelName(name: string, chantypes: readonly string[]): boolean {
  return chantypes.some((sigil) => name.startsWith(sigil));
}
