import { describe, expect, it } from "vitest";

// #388 — per-network SERVICES-IDENTITY store. Seeded by the
// `session_identity_changed` user-topic event, which carries the server's ONE
// normalized verdict (bahamut `+r`, OFTC `+R`, IRCv3 `account-notify` and
// numeric 330 all folded server-side). cic mirrors the verdict; it never
// derives identity from a umode letter, which is what the registration and
// recover launchers used to do and why they only worked on Azzurra.

import { accountForNetwork, identifiedForNetwork, identityByNetwork, seedIdentity } from "../lib/identity";

describe("identity store", () => {
  it("reads as NOT identified before any seed", () => {
    // The launcher-gate tolerance: an unseeded network shows the register /
    // recover affordance rather than hiding the only way out of an
    // unidentified session.
    expect(identifiedForNetwork(9999)).toBe(false);
    expect(accountForNetwork(9999)).toBeNull();
  });

  it("seeds the verdict and the account keyed by network id", () => {
    seedIdentity(7, true, "vjt");
    expect(identityByNetwork()[7]).toEqual({ identified: true, account: "vjt" });
    expect(identifiedForNetwork(7)).toBe(true);
    expect(accountForNetwork(7)).toBe("vjt");
  });

  it("carries identified with a null account — the normal bahamut case", () => {
    // bahamut confirms identity via the +r umode and exposes no account
    // name, so a null account must NOT read as unidentified.
    seedIdentity(8, true, null);
    expect(identifiedForNetwork(8)).toBe(true);
    expect(accountForNetwork(8)).toBeNull();
  });

  it("is last-write-wins per network, so a logout clears the verdict", () => {
    seedIdentity(9, true, "vjt");
    seedIdentity(9, false, null);
    expect(identifiedForNetwork(9)).toBe(false);
    expect(accountForNetwork(9)).toBeNull();
  });

  it("keys per network — one identified network does not identify another", () => {
    seedIdentity(10, true, "vjt");
    expect(identifiedForNetwork(11)).toBe(false);
  });
});
