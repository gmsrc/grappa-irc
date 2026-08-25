import { describe, expect, it } from "vitest";

// #1255 — the channel sigil class became per-network data. These pin the
// pure half (the fact + the test); `isupport.test.ts` covers the store half
// (`chantypesForNetwork`) and `slashCommands.test.ts` covers the parser
// reading it.

import { DEFAULT_CHANTYPES, isChannelName } from "../lib/chantypes";

describe("chantypes", () => {
  it("defaults to the RFC 2812 class every open-coded copy assumed", () => {
    // The pre-005 default is not a preference: it is what cic did before the
    // widening, so an unseeded network must behave identically.
    expect([...DEFAULT_CHANTYPES]).toEqual(["#", "&", "+", "!"]);
  });

  it("accepts every RFC sigil under the default set", () => {
    for (const name of ["#italia", "&local", "+modeless", "!11111chan"]) {
      expect(isChannelName(name, DEFAULT_CHANTYPES)).toBe(true);
    }
  });

  it("rejects a nick, and an empty string, under the default set", () => {
    expect(isChannelName("vjt", DEFAULT_CHANTYPES)).toBe(false);
    expect(isChannelName("", DEFAULT_CHANTYPES)).toBe(false);
  });

  it("narrows to what the network advertises", () => {
    // A network publishing `CHANTYPES=#` has no `&`, `+` or `!` channels.
    // Treating `&foo` as one there builds a JOIN the ircd refuses — the
    // whole reason this stopped being a constant.
    expect(isChannelName("#italia", ["#"])).toBe(true);
    expect(isChannelName("&local", ["#"])).toBe(false);
    expect(isChannelName("+modeless", ["#"])).toBe(false);
  });

  it("honours a sigil outside the RFC class", () => {
    // The point of reading 005 is that the set is the NETWORK's, not ours.
    expect(isChannelName("~weird", ["~"])).toBe(true);
    expect(isChannelName("#italia", ["~"])).toBe(false);
  });

  it("is empty-set safe: nothing is a channel when nothing is advertised", () => {
    expect(isChannelName("#italia", [])).toBe(false);
  });
});
