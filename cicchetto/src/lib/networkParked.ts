import type { Network } from "./api";

// issue 1985 — the ONE statement of "this network is not in the UI right now".
//
// vjt's ruling (2026-09-07, option 1 of the issue): while a network is
// `parked` it and every row under it LEAVE the sidebar, and come back when it
// reconnects. Two callers derive from this predicate and they must never
// disagree — the Sidebar's `<For>` (which rows to draw) and Shell's cold-load
// restore gate (whether the saved window is still somewhere the operator can
// be). A second copy of the string in either place is how the pane and the
// sidebar drift into showing different worlds.
//
// `failed` is deliberately NOT here and must not be added: a failed network
// stays greyed IN PLACE because the operator has to see a failure and act on
// it (`Sidebar.tsx` NETWORK_GREYED_STATES). `failing` is not here either, for
// #1675's reason — it is retrying on its own and has a way back. The
// asymmetry between the three states is the product decision, not an
// oversight, and a future "any non-connected state" generalisation would
// silently take all three.
//
// Its OWN module, not a function inside `lib/networks.ts`, for a testing
// reason that is also a design one: `networks.ts` is a resource singleton
// (createResource over the bearer), so every suite that touches it replaces
// it wholesale with `vi.mock`. A predicate living there would be mocked
// alongside the resources at every call site and could only ever be tested
// through a mirror of itself. Here it is pure, importable, and the suites
// that mock `networks.ts` run the REAL rule.
//
// issue 2222 — the predicate reads `connection_state` and nothing else. It
// used to narrow on `kind === "user"` first, justified right here by "only a
// UserNetwork carries `connection_state`, so a visitor network can never be
// parked and can never be hidden". #211 phase 6 converged the visitor row onto
// the user twin and retired that premise: both
// `NetworksWireNetworkWithNickJson` and `NetworksWireVisitorNetworkWithNickJson`
// declare `connection_state` NON-OPTIONAL, and `tagNetwork` drops a row
// missing it as a server contract violation for EITHER kind.
//
// The premise line is deleted rather than corrected on purpose: it is the
// sentence that made the narrow look right, so leaving it would put the narrow
// back at the next reading.
//
// Measured, so this is not an inert change: prod `network_credentials` id 712
// is a visitor row at `connection_state = "parked"`, `user_id` NULL. vjt's
// ruling (2026-09-16) is "stesso comportamento per user e visitor" — the
// subject is not part of the rule. This changes WHO the rule applies to, not
// WHAT it is: `failed` and `failing` stay out, for the reasons above.
export function isNetworkParked(net: Network | undefined): boolean {
  return net?.connection_state === "parked";
}
