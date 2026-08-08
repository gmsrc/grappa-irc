import { type Accessor, createSignal } from "solid-js";

// #119 — device connectivity signal. Module-singleton mirroring the
// `socketHealth.ts` / `bundleHash.ts` shape. Tracks whether the browser
// reports the device as online via `navigator.onLine` seeded at init and the
// `online` / `offline` window events thereafter.
//
// Why this exists (vjt refinement, 2026-07-04): the old SocketHealthBanner
// guessed "your origin is most likely misconfigured" on a WS 1006 abnormal
// close. That is a FALSE cause — a 1006 with no server reason most often just
// means there is no connection at all, which the browser already tells us
// directly. This signal is the honest answer the 1006 heuristic could only
// guess at: when the device is offline, the stacked error region shows a real
// "you are offline" entry (see `errorBanners.ts`), and the deleted origin arm
// is gone.
//
// Scope boundary: this module owns ONLY the connectivity signal — it has no
// socket knowledge and no banner knowledge. The dependency runs ONE way:
// `socket.ts` and `errorBanners.ts` both read `isOffline()`; this module reads
// neither of them.
//
// #1061 REVERSES the "they just observe the same two window events
// independently" note this comment used to carry. Two independent readings of
// the same browser state can DISAGREE — and when they did, the disagreement
// was the bug in both directions: the socket kept dialling a network the
// banner was already calling dead, and the banner stacked a WS close-code
// entry on top of its own offline entry. One predicate, read by everyone who
// needs it, is what makes those two states impossible. socket.ts still owns
// its own `online`/`offline` LISTENERS (the reconnect kick is a socket
// lifecycle concern, not a UI one); what it no longer owns is a second opinion
// on whether the device is offline.

const initialOnline = (): boolean => (typeof navigator === "undefined" ? true : navigator.onLine);

const [online, setOnline] = createSignal<boolean>(initialOnline());

// True when the browser reports the device as offline. Reactive: reading it
// inside a tracked scope (the ErrorBanners <For>) re-derives on every
// online/offline transition.
export const isOffline: Accessor<boolean> = () => !online();

if (typeof window !== "undefined") {
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
}

// Test-only — force the signal to a known state. Production code never calls
// this; the window online/offline events are the only production mutators.
export function __setConnectivityForTests(isOnline: boolean): void {
  setOnline(isOnline);
}
