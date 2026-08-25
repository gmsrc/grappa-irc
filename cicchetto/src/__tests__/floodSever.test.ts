import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setToken } from "../lib/auth";
import { setSeveredForFlood, severedForFlood } from "../lib/floodSever";

// #630 — inbound-flood web-session sever latch.
//
// These cover the STORE contract (a plain module-level signal that must
// outlive the socket teardown + logout the sever triggers) and its clear
// lifecycle on the auth side. The narrower + dispatch arms are covered in
// `__tests__/userTopic.test.ts` (the house pattern for every user-topic event
// arm). Production code only — `auth.setToken` is exercised directly (it is
// exactly what a successful login reaches after `api.login` resolves), no
// re-implementation.

describe("floodSever store (#630)", () => {
  beforeEach(() => {
    setSeveredForFlood(false);
    localStorage.clear();
  });

  afterEach(() => {
    setSeveredForFlood(false);
    localStorage.clear();
  });

  it("defaults to not-severed", () => {
    expect(severedForFlood()).toBe(false);
  });

  it("latches true, then clears back to false", () => {
    setSeveredForFlood(true);
    expect(severedForFlood()).toBe(true);
    setSeveredForFlood(false);
    expect(severedForFlood()).toBe(false);
  });

  // The critical sever invariant: the flag must SURVIVE the token-clear the
  // sever's own bearer-revoke triggers (setToken(null) → the 401 logout edge).
  // If it didn't, the banner would never render — the flag would be gone before
  // the user landed back on the login screen.
  it("survives a logout / token-clear (setToken(null) does NOT clear it)", () => {
    setSeveredForFlood(true);
    setToken(null);
    expect(severedForFlood()).toBe(true);
  });

  // Cleared on the next successful login: acquiring a valid bearer (the
  // token-acquire edge `auth.setToken(nonNull)` reaches on every login) drops
  // the latch so the banner doesn't linger into the fresh session.
  it("clears on a successful login (setToken with a non-null bearer)", () => {
    setSeveredForFlood(true);
    setToken("fresh-bearer-token");
    expect(severedForFlood()).toBe(false);
  });
});
