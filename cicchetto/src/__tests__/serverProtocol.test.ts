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
import { narrowCredentialResponse } from "../lib/wireNarrow";

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

// #1654's open half, for the one narrower where the field → version fact
// EXISTS rather than having to be invented.
//
// `serverProtocol.ts` states the obligation and says nothing enforces it, and
// `protocol_test.exs` says the same from the Elixir side and explains why:
// catching "forgot to raise the floor" in general needs a ledger of WHICH
// protocol version introduced each field, and `priv/wire/shape.pin` holds a
// digest of the CURRENT shape, not a history. That is still true. This does
// not build the ledger; it uses the ONE entry the repo already wrote down —
// `Grappa.Protocol`'s v9 note names `age`, `gender`, `location`, `languages`,
// `custom` and `avatar_url` as joining the credential payload at 9 — and ties
// the two facts for that shape alone.
//
// Stated as an IMPLICATION, deliberately, and NOT as a pin on the constant.
// A pin (`expect(MIN).toBe(9)`) would test the number; this tests the RULE,
// and it stays honest under EITHER cure: relax the narrower so a pre-profile
// credential reads, and the antecedent is false and the floor is free to sit
// wherever it likes; leave the narrower strict, and the floor has to say so.
// What it forbids is the state main is in today — strict narrower, floor that
// claims to accept a server that cannot satisfy it.
describe("the floor vs the credential shape the narrower demands (#1654)", () => {
  // The protocol version at which the six profile fields joined
  // `Grappa.Networks.Wire.credential_json/0`. Not derivable from anything the
  // bundle ships: the pin next door carries the CURRENT number, which equals
  // this one only until the next bump. Hand-carried from the server's own
  // `@protocol_version 9` note, which is where that fact is written.
  const PROFILE_FIELDS_PROTOCOL_VERSION = 9;

  // Exactly the keys `credential_json/0` declared BEFORE the profile fields —
  // i.e. the whole body a protocol-8 server puts on the wire, not a trimmed
  // sample. Measured against the generated schema at the merge base, and it
  // is the same 13 keys the e2e vhost stub was serving when it went red.
  const PRE_PROFILE_CREDENTIAL = {
    network: "azzurra",
    nick: "e2e-p282",
    ident: null,
    realname: null,
    sasl_user: null,
    auth_method: "none",
    auth_command_template: null,
    autojoin_channels: [],
    connection_state: "parked",
    connection_state_reason: null,
    connection_state_changed_at: null,
    inserted_at: "2026-08-16T00:00:00Z",
    updated_at: "2026-08-16T00:00:00Z",
  };

  // The same body a CURRENT server sends: the six fields present and null,
  // which is what `credential_to_json/1` renders for a credential carrying no
  // profile. Null, not populated — a fixture that only proves the happy shape
  // would not catch a narrower that rejects the absent-value case.
  const CURRENT_CREDENTIAL = {
    ...PRE_PROFILE_CREDENTIAL,
    age: null,
    gender: null,
    location: null,
    languages: null,
    custom: null,
    avatar_url: null,
  };

  // `narrowCredentialResponse` THROWS rather than returning null (REST cannot
  // answer with null the way the WS narrowers do), so "can this bundle read
  // it" is a try/catch, not a truthiness check.
  function readsCleanly(raw: unknown): boolean {
    try {
      narrowCredentialResponse(raw);
      return true;
    } catch {
      return false;
    }
  }

  // POSITIVE CONTROL. Without it, a typo in either fixture makes
  // `readsCleanly` answer false for a reason that has nothing to do with the
  // profile fields, and the implication below would then be satisfiable by
  // raising the floor over a defect that is not there.
  it("reads a credential from a CURRENT server — the fixtures are sane", () => {
    expect(readsCleanly(CURRENT_CREDENTIAL)).toBe(true);
  });

  // NEGATIVE CONTROL: `readsCleanly` is not simply answering true.
  it("does not read something that is not a credential at all", () => {
    expect(readsCleanly("not a credential")).toBe(false);
  });

  it("never claims a floor below the oldest credential shape it can read", () => {
    const readsPreProfile = readsCleanly(PRE_PROFILE_CREDENTIAL);
    const floorCoversIt = MIN_SERVER_PROTOCOL_VERSION >= PROFILE_FIELDS_PROTOCOL_VERSION;

    expect(
      readsPreProfile || floorCoversIt,
      `this bundle rejects the credential a protocol-${PROFILE_FIELDS_PROTOCOL_VERSION - 1} ` +
        `server sends, yet declares MIN_SERVER_PROTOCOL_VERSION = ${MIN_SERVER_PROTOCOL_VERSION}. ` +
        "Per serverProtocol.ts: either relax the narrower so the older body reads, " +
        `or raise the floor to ${PROFILE_FIELDS_PROTOCOL_VERSION}.`,
    ).toBe(true);
  });
});
