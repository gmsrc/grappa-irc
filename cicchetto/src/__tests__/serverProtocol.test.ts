import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetServerProtocolForTests,
  MIN_SERVER_PROTOCOL_VERSION,
  serverOutdatedMessage,
  serverProtocol,
  setServerProtocol,
  shouldShowServerOutdatedBanner,
} from "../lib/serverProtocol";
import { CLIENT_PROTOCOL_VERSION } from "../lib/socket";

// #1393d — the client-side server floor.
//
// The boundaries are stated against `MIN_SERVER_PROTOCOL_VERSION` rather than
// against a literal, so the suite keeps testing the RULE after the next bump
// instead of testing the number 2. A literal here would have to be edited on
// every bump, and an edited assertion is one nobody reads.
describe("serverProtocol — the client-side floor (#1393d)", () => {
  beforeEach(() => {
    __resetServerProtocolForTests();
  });

  it("shows nothing before the join reply lands", () => {
    expect(serverProtocol()).toBeNull();
    expect(shouldShowServerOutdatedBanner()).toBe(false);
  });

  // Unknown is not too-old. cic does not originate state: a server that named
  // no number told us nothing, and inferring "therefore ancient" would be the
  // same invention the narrowers just stopped making.
  it("does not treat an unknown server protocol as too old", () => {
    expect(shouldShowServerOutdatedBanner()).toBe(false);
  });

  it("fires at exactly one below the floor", () => {
    setServerProtocol(MIN_SERVER_PROTOCOL_VERSION - 1);
    expect(shouldShowServerOutdatedBanner()).toBe(true);
  });

  it("does NOT fire AT the floor (>= is the contract, not >)", () => {
    setServerProtocol(MIN_SERVER_PROTOCOL_VERSION);
    expect(shouldShowServerOutdatedBanner()).toBe(false);
  });

  // A server AHEAD of this bundle is the additive direction, and that one
  // really is tolerated — it is the half of #447 this slice did NOT repeal.
  it("does NOT fire for a server NEWER than this bundle", () => {
    setServerProtocol(MIN_SERVER_PROTOCOL_VERSION + 10);
    expect(shouldShowServerOutdatedBanner()).toBe(false);
  });

  it("names both numbers in the message so the operator can act on it", () => {
    setServerProtocol(MIN_SERVER_PROTOCOL_VERSION - 1);
    const msg = serverOutdatedMessage();
    expect(msg).toContain(String(MIN_SERVER_PROTOCOL_VERSION - 1));
    expect(msg).toContain(String(MIN_SERVER_PROTOCOL_VERSION));
  });

  // The two client-side numbers are separate constants on purpose (a later
  // bundle may SPEAK v5 and still cope with a v2 server), but a bundle that
  // required MORE than it speaks would refuse every server that accepts it.
  // That is incoherent in a way no runtime check would ever surface, so it is
  // pinned here.
  it("never requires a server newer than the protocol this bundle speaks", () => {
    expect(MIN_SERVER_PROTOCOL_VERSION).toBeLessThanOrEqual(CLIENT_PROTOCOL_VERSION);
  });
});
