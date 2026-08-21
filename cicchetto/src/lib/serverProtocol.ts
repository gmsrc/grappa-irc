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
export const MIN_SERVER_PROTOCOL_VERSION = 2;

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
