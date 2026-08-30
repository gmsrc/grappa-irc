import { type Accessor, createSignal } from "solid-js";

// #1393d — the client-side SERVER floor: the oldest wire protocol this
// bundle can still talk to.
//
// ## Why a floor exists on THIS side now
//
// `Grappa.Protocol.min_version/0` is the mirror of this number and points
// the other way: it gates an old CLIENT against a new server, refused at the
// WS handshake with a 426. There has never been anything pointing this way,
// and until #1393d nothing needed to: a newer cic tolerated an older BEAM by
// construction, because every field it did not receive it invented.
//
// #1393d ended that. cic now REQUIRES fields an older BEAM does not send
// (`isupport_changed.list_modes_queryable` and its two siblings,
// `window_invited.inviter`, `network.recoverable`,
// `whois_bundle.extra_lines`) and drops the whole envelope rather than
// making a value up. That is a real and routine deploy class here — a
// `--cic`-only bundle push leaves the BEAM behind — and without this floor
// its symptom is /banlist quietly gone, the /mode toggles dead and the
// invited tab broken, with nothing anywhere saying why.
//
// ## Why the number can be trusted, which it could not be before
//
// A floor is only worth comparing against if the number is TOTAL. Measured
// on this repo: `@protocol_version` sat at `1` from #447 (2026-07-27)
// through five additive field adds, because the rule of the day said an
// additive change does not bump. Under that rule this constant would be `1`,
// every server in existence would satisfy it, and it would fire on none of
// them — a floor that lies, which is worse than no floor because the client
// believes it checked.
//
// vjt's ruling (2026-08-21) is what makes it honest: the server bumps on
// EVERY wire-shape change from now on, additive included. So `server >= N`
// really does mean "the server has everything N had".
//
// ## Not the same thing as the drop banner
//
// `wireDrop.ts` reports that cic THREW SOMETHING AWAY. It is a diagnostic
// and it fires for a mangling proxy just as readily as for an old BEAM. This
// module reports a FACT the server stated about itself, before any payload
// arrives. Keep them apart: one answers "why is this broken", the other
// answers "what is broken".

// The protocol this bundle SPEAKS lives in `socket.ts`
// (`CLIENT_PROTOCOL_VERSION`) because that is where it is put on the wire.
// This is the protocol it REQUIRES, and the two are deliberately separate
// constants: a future bundle may speak v5 while still coping with a v2
// server, and collapsing them would make every bump a forced floor raise.
//
// Mirrors `Grappa.Protocol.min_version/0`'s naming, pointed at the peer this
// side is judging.
//
// 🔴 THE OBLIGATION. Narrowing any guard to REQUIRE a field introduced by
// protocol version N obliges you to raise this number to N in the same
// change. Forget it and a bundle needing a v5 field goes on accepting a
// v2–v4 server, drops every envelope missing that field and shows NO banner:
// the silent mode this module was written to end, reintroduced by the module
// itself.
//
// It was forgotten exactly once and it went exactly that way. The #1280
// per-network profile put `age`, `gender`, `location`, `languages`, `custom`
// and `avatar_url` on `Grappa.Networks.Wire.credential_json/0` at protocol 9
// and generated them REQUIRED (no `q:` in `wireSchema.ts`, unlike the
// `optional(:gender)` its own sibling `Session.Wire.member/0` carries), while
// this number stayed at 2. Measured on the artefact rather than argued: the
// e2e vhost stub was serving the 13-key body of a protocol-8 server, the
// trace shows `narrowCredentialResponse` throwing `WireShapeError` on it, one
// PATCH on the wire instead of two, and the network left PARKED with the
// reconnect leg never issued. No banner, because 8 >= 2.
//
// Hence 9, and hence `CLIENT_PROTOCOL_VERSION` moving with it — the pinned
// `MIN_SERVER <= CLIENT` invariant is what makes the pair move together, and
// 2 was in any case stale against a server that has been at 9 since #1280.
//
// This does NOT make the bundle tolerant; it makes it HONEST. A protocol-8
// server still cannot have its credential read here — the banner now says so
// instead of the operator finding out from a network that parks and stays
// parked. Relaxing the narrower (the six fields `optional(:…)` on the server
// typespec, the #1766 `show_bottom_bar?` shape) is the OTHER cure and the one
// that removes the condition rather than announcing it; it is a server-side
// change that moves the shape digest and therefore costs a protocol bump of
// its own, which is why it is not folded in here.
//
// Still named debt (DESIGN_NOTES 2026-08-21, #1393d): the GENERAL gate needs
// the field → version-that-introduced-it history, and `priv/wire/shape.pin`
// holds a digest of the current shape, not a history. What exists now is one
// entry of that ledger, written where the fact already was — the credential
// shape is tied to this constant by an implication test in
// `serverProtocol.test.ts`, which passes under EITHER cure and fails only on
// the state above. Every other narrower is still on trust.
export const MIN_SERVER_PROTOCOL_VERSION = 9;

// `null` until the user-topic join reply lands (or if it carries no number
// at all — a server old enough to predate #447's join-reply field, which is
// itself below the floor but cannot be measured, only inferred). Unknown is
// NOT treated as too-old: cic does not originate state, and a missing number
// is an absence of evidence rather than evidence.
const [serverProtocolSignal, setServerProtocolInternal] = createSignal<number | null>(null);

export const serverProtocol: Accessor<number | null> = serverProtocolSignal;

export function setServerProtocol(version: number): void {
  setServerProtocolInternal(version);
}

/** Test seam — back to "the join reply has not landed yet". */
export function __resetServerProtocolForTests(): void {
  setServerProtocolInternal(null);
}

/** True once the server has NAMED a protocol below what this bundle needs. */
export function shouldShowServerOutdatedBanner(): boolean {
  const server = serverProtocol();
  return server !== null && server < MIN_SERVER_PROTOCOL_VERSION;
}

// The operator is the audience: the actionable half is "the BEAM was not
// restarted", which is the one thing the number can tell them and the one
// thing no other signal shows. Reloading the page will NOT fix it, so the
// banner deliberately offers no reload action — unlike `bundle-refresh`,
// whose whole point is that a reload does fix it.
export function serverOutdatedMessage(): string {
  const server = serverProtocol();
  return `Server speaks wire protocol ${server ?? "?"}, this client needs ${MIN_SERVER_PROTOCOL_VERSION} — some features are unavailable until the server is updated.`;
}
