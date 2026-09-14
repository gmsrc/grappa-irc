import { describe, expect, it } from "vitest";
import { peelStatusmsg } from "../lib/statusmsg";

// issue 2179 — the client twin of `Grappa.IRC.Identifier.peel_statusmsg/2`.
// Every case below is taken from that function's own suite
// (`test/grappa/irc/identifier_test.exs`, the `peel_statusmsg/2` describe) and
// asserted to the SAME answer: the two are a prediction and its oracle, and a
// divergence means cic either routes a target the send door refuses or files a
// legitimate ops-only send down the phantom-window path.
const BAHAMUT = ["@", "+"];
const HALFOP = ["@", "%", "+"];

describe("peelStatusmsg — the membership-level address", () => {
  it("peels a single advertised sigil off a channel", () => {
    expect(peelStatusmsg("@#chan", BAHAMUT)).toEqual({ channel: "#chan", level: "@" });
    expect(peelStatusmsg("+#chan", BAHAMUT)).toEqual({ channel: "#chan", level: "+" });
  });

  it("#1303 — records the WHOLE run, not the outermost sigil", () => {
    // A STATUSMSG target reaches the UNION of the named levels. Recording only
    // `@` would badge as ops-only a line voiced members also read, with the
    // `+` gone and no reader able to correct it.
    expect(peelStatusmsg("@+#chan", BAHAMUT)).toEqual({ channel: "#chan", level: "@+" });
    expect(peelStatusmsg("@%#chan", HALFOP)).toEqual({ channel: "#chan", level: "@%" });
    expect(peelStatusmsg("%@#chan", HALFOP)).toEqual({ channel: "#chan", level: "%@" });
  });

  it("backtracks on the `+` collision instead of over-peeling", () => {
    // `+` is BOTH the voice sigil and an RFC channel sigil. A plain greedy peel
    // of `@+chan` takes both bytes, finds `chan` is no channel, and has to roll
    // the whole thing back — losing a target the single-sigil peel gets right.
    expect(peelStatusmsg("@+chan", BAHAMUT)).toEqual({ channel: "+chan", level: "@" });
    expect(peelStatusmsg("++chan", BAHAMUT)).toEqual({ channel: "+chan", level: "+" });
  });

  it("peels NOTHING when no split leaves a channel behind", () => {
    // The whole-peel rollback: `+chan` would peel to `chan`, which is no
    // channel, so no voice level is invented on a channel anyone can read.
    expect(peelStatusmsg("+chan", BAHAMUT)).toBeNull();
    expect(peelStatusmsg("#chan", BAHAMUT)).toBeNull();
    expect(peelStatusmsg("someone", BAHAMUT)).toBeNull();
    expect(peelStatusmsg("", BAHAMUT)).toBeNull();
  });

  it("refuses a sigil over a NICK — this is a CHANNEL address or nothing", () => {
    // The `/msg @bob` guard, and it comes free: a run with no channel behind it
    // is not a membership address, so the arm never routes one.
    expect(peelStatusmsg("@bob", BAHAMUT)).toBeNull();
    expect(peelStatusmsg("@", BAHAMUT)).toBeNull();
  });

  it("refuses a sigil this network does not advertise", () => {
    // The acceptance, on the client half: `%` is not in bahamut's run, so
    // `%#chan` is not an address cic may peel. Nothing is STRIPPED — the
    // whole target stays whatever it was, and the send door gets the last word.
    expect(peelStatusmsg("%#chan", BAHAMUT)).toBeNull();
    expect(peelStatusmsg("@#chan", [])).toBeNull();
  });

  it("is pinned to the RFC channel class, not the network's CHANTYPES", () => {
    // The remainder test mirrors `Identifier.channel_sigil?/1`, which the
    // server hardcodes to `#&!+` on purpose. Predicting the door with a
    // different class routes targets the door then refuses — so `&x` and `!x`
    // count as channels here whatever a network advertises.
    expect(peelStatusmsg("@&local", BAHAMUT)).toEqual({ channel: "&local", level: "@" });
    expect(peelStatusmsg("@!ABCDEchan", BAHAMUT)).toEqual({ channel: "!ABCDEchan", level: "@" });
  });
});
