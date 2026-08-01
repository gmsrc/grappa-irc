import { describe, expect, it } from "vitest";
import { channelKey } from "../lib/channelKey";
import { registerPing, resolvePing } from "../lib/pingCorrelation";

// #591 — the /ping reply-correlation table. Pure register/resolve with time
// passed in explicitly (sentAtMs at register, nowMs at resolve) so the RTT
// math is testable WITHOUT touching the wall clock (spec requirement). Tests
// use distinct (network, nick, token) triples so the shared identity-scoped
// store can't cross-contaminate. sourceKey is a branded ChannelKey built via
// channelKey(slug, name) (the SSOT encoder), never a hand-spelled string.
describe("pingCorrelation", () => {
  it("resolves a matching ping with the RTT delta and source window", () => {
    registerPing(1, "bob", "tok-a", channelKey("freenode", "#chan"), "#chan", 1000);

    expect(resolvePing(1, "bob", "tok-a", 1042)).toEqual({
      sourceKey: channelKey("freenode", "#chan"),
      sourceChannel: "#chan",
      rttMs: 42,
    });
  });

  it("returns null when nothing matches", () => {
    expect(resolvePing(1, "nobody", "tok-none", 5000)).toBeNull();
  });

  it("folds the nick (CASEMAPPING=ascii) — register Bob, resolve bob", () => {
    registerPing(1, "Bob", "tok-b", channelKey("freenode", "#room"), "#room", 2000);

    expect(resolvePing(1, "bob", "tok-b", 2100)).toEqual({
      sourceKey: channelKey("freenode", "#room"),
      sourceChannel: "#room",
      rttMs: 100,
    });
  });

  it("is one-shot: a second resolve of the same reply is null", () => {
    registerPing(1, "carol", "tok-c", channelKey("freenode", "carol"), "carol", 3000);

    expect(resolvePing(1, "carol", "tok-c", 3050)).not.toBeNull();
    expect(resolvePing(1, "carol", "tok-c", 3060)).toBeNull();
  });

  it("does not match across networks or tokens", () => {
    registerPing(1, "dave", "tok-d", channelKey("freenode", "dave"), "dave", 4000);

    // Wrong network id.
    expect(resolvePing(2, "dave", "tok-d", 4010)).toBeNull();
    // Wrong token.
    expect(resolvePing(1, "dave", "tok-other", 4010)).toBeNull();
    // The real one still resolves.
    expect(resolvePing(1, "dave", "tok-d", 4010)).not.toBeNull();
  });
});
