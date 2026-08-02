import { type Accessor, createSignal } from "solid-js";

// #630 — inbound-flood web-session sever latch.
//
// When a client floods grappa inbound, the server SEVERS the web session:
// it (1) broadcasts a `web_session_severed` (code: "rate_limit_flood")
// event on the user topic, THEN (2) revokes the auth bearer, THEN (3)
// closes the socket. This module-level signal latches that fact so the
// login / re-login screen (Login.tsx) can render a DEDICATED "you were
// disconnected for sending too fast" banner INSTEAD of the generic
// logged-out state.
//
// DELIBERATELY a plain module-level signal, NOT an `identityScopedStore`:
// the sever's own bearer-revoke makes cic's 401 handler fire
// `auth.setToken(null)` — the exact logout/token-clear transition
// `identityScopedStore` resets on. A scoped store would erase this flag the
// instant the sever cleared the token, BEFORE the banner ever rendered. The
// latch MUST outlive the socket teardown + logout; a plain module signal
// does (same survives-token-transition posture as `bundleHash.ts`).
//
// Cleared on the NEXT successful login (`auth.ts` `setToken` with a non-null
// bearer), never on logout — see the guarded clear in auth.ts.

const [severedForFloodSignal, setSeveredForFloodInternal] = createSignal(false);

export const severedForFlood: Accessor<boolean> = severedForFloodSignal;

export function setSeveredForFlood(value: boolean): void {
  setSeveredForFloodInternal(value);
}
