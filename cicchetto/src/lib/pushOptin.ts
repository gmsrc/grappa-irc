import { createSignal } from "solid-js";
import { token } from "./auth";
import { enablePush, pushAvailable } from "./push";

// #459 — the push opt-in banner's owner module.
//
// Push notifications are only reachable from settings today, so nobody finds
// them. This offers them ONCE, on login, in the existing top-banner region.
// This module is that source's single owner — mirroring swRegistration.ts: the
// registry (errorBanners.ts) asks `shouldShowPushOptinBanner()` and wires the
// two verbs (`acceptPushOptin` for [of course!], `declinePushOptin` for ×). No
// parallel state lives in the registry (derive, don't duplicate).
//
// Two rules decide correctness (both from the issue, both load-bearing):
//   1. [of course!] IS the user gesture. `Notification.requestPermission()`
//      needs one on Safari (desktop + iOS). `enablePush` calls it before its
//      first `await`, so `acceptPushOptin` invokes `enablePush` SYNCHRONOUSLY
//      from the click — the bearer is read from the signal, never awaited inside
//      the handler — and the gesture survives.
//   2. × must NEVER call `requestPermission`. The browser prompt is one-shot
//      per origin: a `denied` there is permanent and unrecoverable from the
//      page. Asking ourselves first means a decline leaves the origin at
//      `default`, so the settings toggle still works afterward.

// The PERSISTED × decline. Per-browser is correct: it shadows a per-browser
// Notification permission, so — unlike #449's move to server-side prefs — this
// stays in localStorage and does NOT sync across devices.
//
// EXPORTED (#1646): a localStorage key is already a public contract — the slot
// is readable and writable by anything sharing the origin — so naming it costs
// no encapsulation that `localStorage` had not already given away. The e2e spec
// that seeds a declined state mirrors this string by hand; exporting it lets
// `src/__tests__/e2eConstantMirrors.test.ts` hold the two copies together.
export const PUSH_OPTIN_DECLINED_KEY = "cic.pushOptinDeclined";

// SESSION-scoped hide, reactive so the banner drops the instant the user acts
// (accept or ×) without waiting for another source signal to re-derive the
// registry. Reset to false only on module load — i.e. a genuine page load, NOT
// an in-tab logout→login (cic rebuilds the socket on logout without a reload),
// so the "re-offer next login" for a dismissed OS prompt (permission stayed
// `default`) fires on the next page load. Accept-grant and decline are both
// durable regardless (permission moves off `default` / localStorage persists),
// so only that one edge is reload-scoped. Cross-session persistence of a ×
// lives in localStorage (read live by the gate below), never here — keeping
// "this session" and "forever" two distinct, non-drifting pieces of state.
const [hidden, setHidden] = createSignal(false);

function persistedDeclined(): boolean {
  try {
    return localStorage.getItem(PUSH_OPTIN_DECLINED_KEY) === "1";
  } catch {
    return false; // private-mode localStorage can throw — treat as not declined
  }
}

/**
 * The gate: `pushAvailable() && Notification.permission === "default" &&
 * !declined`. Order matters — the reactive/localStorage checks short-circuit
 * first, and `pushAvailable()` guarantees `Notification` is present before we
 * read `.permission`. `granted` → nothing to ask; `denied` → the browser blocks
 * re-prompting and no UI of ours can undo it, so a dead button would be worse
 * than silence.
 */
export function shouldShowPushOptinBanner(): boolean {
  if (hidden()) return false;
  if (persistedDeclined()) return false;
  if (!pushAvailable()) return false;
  return Notification.permission === "default";
}

/**
 * [of course!] — accept the offer. Reads the bearer synchronously and calls
 * `enablePush` straight away (gesture-preserving, see rule 1). Hides the banner
 * for the session once the attempt settles, whatever the outcome: a grant/deny
 * already makes the gate false, and a dismissed OS prompt leaves permission
 * `default` — hiding for the session (NOT persisting) re-offers on the next
 * login instead of nagging within this one. No bearer yet → leave the banner up.
 */
export async function acceptPushOptin(): Promise<void> {
  const t = token();
  if (t === null) return;
  try {
    await enablePush(t);
  } catch {
    // Best-effort offer: enablePush RETURNS its expected outcomes
    // (denied/dismissed/unsupported); a THROW is an exceptional infra failure
    // (VAPID fetch, pushManager.subscribe, the subscription POST). The settings
    // master toggle is the durable recovery + diagnostic surface (it dispatches
    // on the typed result), so this one-shot banner swallows the throw rather
    // than leaking an unhandled rejection through the `void acceptPushOptin()`
    // call site. Hiding still applies below — every throw path is post-grant, so
    // the gate won't re-offer regardless.
  } finally {
    setHidden(true);
  }
}

/**
 * [×] — decline. Persists (banner never returns until the settings toggle is
 * used) AND hides for this session immediately. NEVER prompts (rule 2).
 */
export function declinePushOptin(): void {
  try {
    localStorage.setItem(PUSH_OPTIN_DECLINED_KEY, "1");
  } catch {
    /* private-mode localStorage can throw — the session hide below still holds */
  }
  setHidden(true);
}

// Test-only — reset the session hide. Production never calls this; accept/× are
// the only mutators (localStorage is cleared by the test harness separately).
export function __resetPushOptinForTests(): void {
  setHidden(false);
}
