import { describe, expect, it } from "vitest";

// #216 — per-network ISUPPORT capability store. Seeded by the
// `isupport_changed` user-topic event (server parses CHANMODES + PREFIX
// from 005 RPL_ISUPPORT). The `/mode` modal drives its available toggles
// from this table. Mirrors the shape of `channelTopic`'s modes store but
// keyed by network id (ISUPPORT is per-network, not per-channel).

import {
  casemappingForNetwork,
  DEFAULT_ISUPPORT,
  frameBudgetBaseForNetwork,
  type IsupportEntry,
  isupportByNetwork,
  isupportEntryFromWire,
  isupportForNetwork,
  seedIsupport,
} from "../lib/isupport";

// A full `isupport_changed` payload, as the server builds it. Tests override
// the one field they exercise so a new wire fact cannot be added here
// without every case seeing it.
const WIRE_PAYLOAD = {
  chanmodes_a: ["b", "e", "I"],
  chanmodes_b: ["k"],
  chanmodes_c: ["l"],
  chanmodes_d: ["i", "m", "n", "s", "t"],
  list_modes_queryable: ["b", "e", "I"],
  prefix: { o: "@", v: "+" },
  prefix_order: ["o", "v"],
  chantypes: ["#", "&"],
  casemapping: "ascii" as const,
  maxlist: { b: 100, e: 100, I: 100 },
  nicklen: 30,
  channellen: 200,
  topiclen: 307,
  frame_budget_base: 393,
};

describe("isupport store", () => {
  it("DEFAULT_ISUPPORT carries the bahamut/Azzurra seed", () => {
    expect(DEFAULT_ISUPPORT.prefix).toEqual({ o: "@", h: "%", v: "+" });
    expect(DEFAULT_ISUPPORT.chanmodes.a).toContain("b");
    expect(DEFAULT_ISUPPORT.chanmodes.b).toContain("k");
    expect(DEFAULT_ISUPPORT.chanmodes.c).toContain("l");
    expect(DEFAULT_ISUPPORT.chanmodes.d).toContain("n");
  });

  it("isupportForNetwork returns the default before any seed", () => {
    expect(isupportForNetwork(9999)).toEqual(DEFAULT_ISUPPORT);
  });

  // #1108 — the capability table has an honest default (bahamut's, which is
  // what every prod network advertises anyway); the frame BUDGET has none.
  // It is a projection of LINELEN plus the #246 worst-case relay reserve, so
  // a guess is a wrong number the compose box would warn from. Absent means
  // absent, and the affordances stay dark.
  it("DEFAULT_ISUPPORT carries NO frame budget — there is no honest default", () => {
    expect(DEFAULT_ISUPPORT.frameBudgetBase).toBeNull();
    expect(frameBudgetBaseForNetwork(9999)).toBeNull();
  });

  it("frameBudgetBaseForNetwork serves the seeded budget", () => {
    seedIsupport(11, { ...DEFAULT_ISUPPORT, frameBudgetBase: 393 });
    expect(frameBudgetBaseForNetwork(11)).toBe(393);
  });

  it("frameBudgetBaseForNetwork is null for an unknown network id", () => {
    expect(frameBudgetBaseForNetwork(null)).toBeNull();
  });

  it("seedIsupport stores the entry keyed by network id", () => {
    const entry: IsupportEntry = {
      chanmodes: { a: ["b", "e", "I"], b: ["k"], c: ["l"], d: ["i", "m", "n", "s", "t"] },
      prefix: { q: "~", a: "&", o: "@", h: "%", v: "+" },
      prefixOrder: ["q", "a", "o", "h", "v"],
      listModesQueryable: ["b", "e", "I"],
      chantypes: ["#", "&"],
      casemapping: "ascii",
      maxlist: { b: 100 },
      nicklen: 30,
      channellen: 200,
      topiclen: 307,
      frameBudgetBase: 393,
    };
    seedIsupport(7, entry);
    expect(isupportByNetwork()[7]).toEqual(entry);
    expect(isupportForNetwork(7)).toEqual(entry);
  });

  it("isupportForNetwork falls back to default for an unseeded network", () => {
    seedIsupport(7, DEFAULT_ISUPPORT);
    expect(isupportForNetwork(12345)).toEqual(DEFAULT_ISUPPORT);
  });
});

// #1255 — the server parsed six 005 tokens and shipped two. These are the
// per-network facts cic used to open-code as constants: the channel sigil
// class (`[#&+!]` repeated across compose/slashCommands/inviteLink/
// ScrollbackPane), the identifier fold, the list caps #1251's mode switcher
// has to respect, and the length limits that today are only discovered by
// round-tripping an over-long nick or topic through the ircd.
describe("isupport widening (#1255)", () => {
  it("DEFAULT_ISUPPORT mirrors the server seed: RFC sigils, ascii fold, no caps", () => {
    // These defaults are what makes a network that omits the token behave
    // EXACTLY as cic behaved before the widening: the RFC 2812 sigil class
    // is the literal every open-coded copy carried, and `ascii` is the fold
    // `nickEquals.asciiFold` implements. The caps have no honest default —
    // inventing one would reject input the ircd accepts.
    expect(DEFAULT_ISUPPORT.chantypes).toEqual(["#", "&", "+", "!"]);
    expect(DEFAULT_ISUPPORT.casemapping).toBe("ascii");
    expect(DEFAULT_ISUPPORT.maxlist).toEqual({});
    expect(DEFAULT_ISUPPORT.nicklen).toBeNull();
    expect(DEFAULT_ISUPPORT.channellen).toBeNull();
    expect(DEFAULT_ISUPPORT.topiclen).toBeNull();
  });

  it("isupportEntryFromWire folds the widened payload into the store shape", () => {
    const entry = isupportEntryFromWire(WIRE_PAYLOAD);

    expect(entry.chantypes).toEqual(["#", "&"]);
    expect(entry.casemapping).toBe("ascii");
    expect(entry.maxlist).toEqual({ b: 100, e: 100, I: 100 });
    expect(entry.nicklen).toBe(30);
    expect(entry.channellen).toBe(200);
    expect(entry.topiclen).toBe(307);
  });

  it("carries a network whose fold is NOT ascii", () => {
    // solanum/Libera/Rizon advertise rfc1459, where `foo[1]` and `foo{1}` are
    // the SAME identity. Since #1861 cic ACTS on it: `casemappingForNetwork`
    // below feeds `normalizeNick`/`nickEquals`.
    const entry = isupportEntryFromWire({ ...WIRE_PAYLOAD, casemapping: "rfc1459" });
    expect(entry.casemapping).toBe("rfc1459");
  });

  it("carries an absent length limit as null, never as a guess", () => {
    const entry = isupportEntryFromWire({
      ...WIRE_PAYLOAD,
      nicklen: null,
      channellen: null,
      topiclen: null,
    });

    expect(entry.nicklen).toBeNull();
    expect(entry.channellen).toBeNull();
    expect(entry.topiclen).toBeNull();
  });

  // #1861 — the store-reading half of the nick fold. Sibling of
  // `chantypesForNetwork`, and the ONLY door the fold call sites use.
  it("casemappingForNetwork reports the seeded fold, per network", () => {
    seedIsupport(41, isupportEntryFromWire({ ...WIRE_PAYLOAD, casemapping: "rfc1459" }));
    seedIsupport(42, isupportEntryFromWire({ ...WIRE_PAYLOAD, casemapping: "rfc1459_strict" }));
    seedIsupport(43, isupportEntryFromWire({ ...WIRE_PAYLOAD, casemapping: "ascii" }));

    expect(casemappingForNetwork(41)).toBe("rfc1459");
    expect(casemappingForNetwork(42)).toBe("rfc1459_strict");
    expect(casemappingForNetwork(43)).toBe("ascii");
  });

  it("casemappingForNetwork defaults to ascii for an unseeded network and a null id", () => {
    // The narrower fold on both misses: pre-005, a parked session, or no
    // active network at all. Guessing `ascii` merges no identity the ircd
    // keeps apart, which is why it is the safe default in BOTH directions.
    expect(casemappingForNetwork(44)).toBe("ascii");
    expect(casemappingForNetwork(null)).toBe("ascii");
  });

  it("seeds the widened facts per network, keeping networks independent", () => {
    seedIsupport(31, isupportEntryFromWire({ ...WIRE_PAYLOAD, chantypes: ["#"] }));
    seedIsupport(32, isupportEntryFromWire({ ...WIRE_PAYLOAD, chantypes: ["#", "&", "!"] }));

    expect(isupportForNetwork(31).chantypes).toEqual(["#"]);
    expect(isupportForNetwork(32).chantypes).toEqual(["#", "&", "!"]);
    // An unseeded network still gets the RFC set, not a neighbour's.
    expect(isupportForNetwork(33).chantypes).toEqual(["#", "&", "+", "!"]);
  });
});
