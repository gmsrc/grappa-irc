import { patchNetwork } from "./api";
import { token } from "./auth";
import { networks } from "./networks";

// #282 — explicit "Reconnect to apply" verb behind the vhost sub-page
// footer button.
//
// The vhost (source-bind address) is ACCOUNT-level and resolved fresh PER
// CONNECT (`Grappa.Vhosts.effective_source/2`: the subject's selection,
// intersected with its allowed set, picked at connect time). So a changed
// selection is INERT until the upstream socket is re-established. This verb
// BOUNCES every currently-`connected` network — park then reconnect — so
// each fresh connection re-binds from the (new) selection; the server
// re-JOINs and emits `connection_state_changed`, which `userTopic.ts`
// patches in place.
//
// This reuses the SAME per-network `PATCH /networks/:slug {connection_state}`
// path the home-page Reconnect (`HomePane` `DisconnectedRow`) drives — the
// clean SAME-ACCOUNT teardown. It is deliberately NOT:
//   * the #281 identity-change client purge (`identityScopedStore`
//     `onIdentityChange`) — that's account-SWITCH semantics, keyed on a
//     token rotation a same-account bounce never triggers, and its
//     404-storm risk (stale CROSS-account state) does not apply here; nor
//   * the visitor identity-apply path (`updateIdentity` → PATCH
//     /networks/:slug/identity) — that carries nick/ident/realname, not
//     the vhost selection.
//
// Only `:connected` networks are bounced. A `:parked` / `:failed` network
// was left down deliberately (home-page park, admission failure); it will
// pick up the new vhost whenever the user reconnects it from the home
// page. Bouncing it here would be an unrelated state change.
//
// Each network's park→reconnect is sequential (the park must settle before
// the reconnect), but networks are independent so the whole set runs
// concurrently. `Promise.allSettled` — a failure on one network must not
// abort the others (mirrors `quitAll`); failures are logged per-network,
// then the FIRST is re-thrown so the caller can surface it (the button
// renders `friendlyApiError`). A network whose park PATCH fails is never
// reconnected (the sequential await short-circuits its `bounceNetwork`).

/**
 * Bounce ONE network: park it, then reconnect it. The two-leg PATCH itself,
 * with no opinion about WHICH networks deserve it — that is the caller's.
 *
 * #1796 — exported, because the compose verb `/reconnect <slug>` is the same
 * bounce aimed at one slug the operator named. It must not reach for
 * `reconnectConnectedNetworks` below (that is the whole connected SET, the
 * wrong one) nor for `lib/networkReconnect.ts` (#1331: the unpark leg alone,
 * and shaped as a Solid hook for button surfaces).
 *
 * SEQUENTIAL, and that is the #282 decision this function was extracted from
 * rather than a fresh one: "Each network's park→reconnect is sequential (the
 * park must settle before the reconnect)". The park PATCH resolves only after
 * the server has issued the upstream QUIT and stopped the session, so awaiting
 * it is what keeps the connect leg from racing a socket that is still open.
 *
 * `reason` is the upstream QUIT message and therefore rides the PARK leg —
 * the leg that closes the socket. `null` omits the key entirely, which is what
 * the caller with nothing to say passes (the server then supplies its own
 * `user-disconnect`); it is not a default this function chooses.
 *
 * A park that fails means the connect leg never runs: a network that could not
 * be torn down must not be left half-bounced.
 */
export async function bounceNetwork(t: string, slug: string, reason: string | null): Promise<void> {
  const park: { connection_state: "parked"; reason?: string } = { connection_state: "parked" };
  if (reason !== null) park.reason = reason;
  await patchNetwork(t, slug, park);
  await patchNetwork(t, slug, { connection_state: "connected" });
}

export async function reconnectConnectedNetworks(): Promise<void> {
  const t = token();
  if (t === null) return;
  const connected = (networks() ?? []).filter((n) => n.connection_state === "connected");
  if (connected.length === 0) return;

  // No reason: the vhost bounce is not the operator saying goodbye to anyone,
  // and this call has never sent one. The server's own `user-disconnect`
  // stands in.
  const results = await Promise.allSettled(connected.map((n) => bounceNetwork(t, n.slug, null)));
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  for (const f of failures) {
    console.warn("[reconnect] bounce failed:", f.reason);
  }
  const first = failures[0];
  if (first !== undefined) throw first.reason;
}
