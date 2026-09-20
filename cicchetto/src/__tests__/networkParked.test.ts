import { describe, expect, it } from "vitest";
import type { Network } from "../lib/api";
import { isNetworkParked } from "../lib/networkParked";

// issue 1985 — the predicate the ruling is written in. Both the Sidebar and
// Shell suites mock `lib/networks` wholesale (it is a resource singleton), so
// this is the one place the rule itself is measured rather than a call site's
// wiring to it.
//
// The `as unknown as Network` casts are the point of the file, not a
// shortcut: the closed set of `connection_state` values is
// `[connected, parked, failing, failed]` (CLAUDE.md, #1675), and the
// interesting inputs are the four states on EITHER subject kind. Naming each
// state through the type would only let the compiler restate what it already
// knows; what needs proving is which of them the predicate says yes to.
//
// issue 2222 — every case is now a PAIR. #211 phase 6 converged the visitor
// row onto the user twin (`connection_state` is non-optional on both in
// `wireTypes.ts`), so the two kinds are the same shape carrying the same
// field, and vjt's ruling is that they get the same behaviour. A table the
// user side alone can satisfy is exactly how the narrow survived a green
// suite for as long as it did.
const netOfKind = (kind: "user" | "visitor", connection_state: string): Network =>
  ({
    kind,
    id: kind === "user" ? 1 : 2,
    slug: "azzurra",
    nick: kind === "user" ? "vjt" : "guest",
    connection_state,
    connection_state_reason: null,
    connection_state_changed_at: null,
    inserted_at: "",
    updated_at: "",
  }) as unknown as Network;

const userNet = (connection_state: string): Network => netOfKind("user", connection_state);
const visitorNet = (connection_state: string): Network => netOfKind("visitor", connection_state);

// The two kinds, so every case below is written once and measured twice.
const BOTH_KINDS: ReadonlyArray<[string, (s: string) => Network]> = [
  ["user", userNet],
  ["visitor", visitorNet],
];

describe("issue 1985 — isNetworkParked", () => {
  describe.each(BOTH_KINDS)("on a %s network", (_kind, net) => {
    it("says yes to parked", () => {
      expect(isNetworkParked(net("parked"))).toBe(true);
    });

    // The three negatives are the whole asymmetry, one assertion each. A
    // generalisation to "any non-connected state" would turn two of them.
    it("says no to connected", () => {
      expect(isNetworkParked(net("connected"))).toBe(false);
    });

    it("says no to failed — a failure stays greyed in place for the operator to see", () => {
      expect(isNetworkParked(net("failed"))).toBe(false);
    });

    it("says no to failing — #1675, it is retrying on its own", () => {
      expect(isNetworkParked(net("failing"))).toBe(false);
    });
  });

  // issue 2222 — this case used to assert the OPPOSITE, and its comment said a
  // dropped `kind` narrow would make "a visitor network start disappearing
  // from the sidebar". That is now the ruled-for behaviour, not the
  // regression: measured on prod, `network_credentials` id 712 is a visitor
  // row reading `connection_state = "parked"` with `user_id` NULL. The old
  // assertion was pinning the defect in place, so it is inverted rather than
  // joined by a twin — a suite cannot hold both answers.
  it("hides a PARKED VISITOR network, same as a user's (issue 2222)", () => {
    expect(isNetworkParked(visitorNet("parked"))).toBe(true);
  });

  it("says no to an absent network", () => {
    // Shell's cold-load gate calls this with `networkBySlug(slug)`, which is
    // `undefined` for a slug that is no longer bound. Not parked — the saved
    // window is unrestorable for a different reason, and the branches below
    // the gate are the ones that must decide it.
    expect(isNetworkParked(undefined)).toBe(false);
  });
});
