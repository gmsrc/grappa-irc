import { describe, expect, it } from "vitest";
import { canonicalChannel, channelKey, decodeChannelKey } from "../lib/channelKey";

// Codebase audit cic M4 — channelKey encoder + decoder round-trip.
// Pre-fix, Sidebar + subscribe.ts open-coded the composite-key parsing
// independently. The decoder is the paired inverse — channelKey is
// the encoder, decodeChannelKey is the decoder. Round-trip MUST hold
// for every (slug, name) pair the cic generates.

describe("channelKey + decodeChannelKey round-trip", () => {
  it("encodes (slug, name) into space-separated composite", () => {
    expect(channelKey("freenode", "#italia")).toBe("freenode #italia");
  });

  it("decodes back to (slug, name)", () => {
    const k = channelKey("azzurra", "#grappa");
    expect(decodeChannelKey(k)).toEqual({ slug: "azzurra", name: "#grappa" });
  });

  it("preserves the channel-name segment for $server pseudo-channel", () => {
    const k = channelKey("freenode", "$server");
    expect(decodeChannelKey(k)).toEqual({ slug: "freenode", name: "$server" });
  });

  it("preserves the channel-name segment for query (DM) targets", () => {
    const k = channelKey("azzurra", "alice");
    expect(decodeChannelKey(k)).toEqual({ slug: "azzurra", name: "alice" });
  });

  it("returns null for malformed key (no separator)", () => {
    expect(decodeChannelKey("malformed" as unknown as ReturnType<typeof channelKey>)).toBeNull();
  });

  it("uses first space as separator (channel names cannot contain spaces per RFC 2812)", () => {
    // If a channel name accidentally contains a space (e.g. operator
    // typed `/join "#italia weird"`), `indexOf(" ")` splits at the
    // first space — slug = "freenode", name = "#italia weird". The
    // decoder doesn't try to validate the channel name; it just
    // inverts the encoder's shape. RFC 2812 chanstring excludes
    // 0x20 so production keys never hit this edge.
    const k = "freenode #italia weird" as ReturnType<typeof channelKey>;
    expect(decodeChannelKey(k)).toEqual({ slug: "freenode", name: "#italia weird" });
  });

  // #537 — identifier-KEY canonicalisation. Mirrors
  // `Grappa.IRC.Identifier.canonical_target/1` on the server (the
  // sigil-gated `canonical_channel/1` was COLLAPSED into it): the
  // composite KEY folds `A-Z` for BOTH channels AND DM-peer nicks, so
  // `#Chan`/`#chan` AND `Vjt`/`vjt` each resolve to one row/topic.
  // Contract change: pre-#537 this twin left nicks RAW to match a RAW
  // topic key; the server now folds the nick KEY (canonical_target/1), so
  // the client mirror must fold it too or a mixed-case DM window
  // subscribes to a topic the server never broadcasts on.
  describe("channelKey + canonicalChannel: case-insensitive composite", () => {
    it("collapses sigil-channels to lowercase in the composite key", () => {
      expect(channelKey("freenode", "#CHAN")).toBe("freenode #chan");
      expect(channelKey("freenode", "#Chan")).toBe("freenode #chan");
      expect(channelKey("freenode", "#cHaN")).toBe("freenode #chan");
    });

    it("all four RFC 2812 sigils fold (#, &, !, +)", () => {
      expect(channelKey("net", "#UPPER")).toBe("net #upper");
      expect(channelKey("net", "&LOCAL")).toBe("net &local");
      expect(channelKey("net", "!SAFE")).toBe("net !safe");
      expect(channelKey("net", "+MODELESS")).toBe("net +modeless");
    });

    it("folds NICK (DM) KEYS too (#537) — display uses the raw targetNick, not this key", () => {
      // Contract change (#537): pre-collapse the twin left nicks RAW
      // ("net CristoBOT") to match a RAW topic; the server now folds the
      // DM window KEY via `canonical_target/1`, so this composite routing
      // key folds A-Z in lockstep. The original casing survives for
      // DISPLAY (`qw.targetNick` → Sidebar/BottomBar `<NickText>`) and on
      // the WIRE (the raw send target) — this key is never shown or sent.
      expect(channelKey("net", "CristoBOT")).toBe("net cristobot");
      expect(channelKey("net", "Vjt")).toBe("net vjt");
    });

    it("leaves $server unchanged (all-lowercase sentinel — no A-Z to fold)", () => {
      expect(channelKey("net", "$server")).toBe("net $server");
    });
  });

  describe("canonicalChannel — ASCII identifier fold (channels + nicks, #537)", () => {
    it("lowercases sigil-prefixed channel names", () => {
      expect(canonicalChannel("#Chan")).toBe("#chan");
      expect(canonicalChannel("&LocalChan")).toBe("&localchan");
      expect(canonicalChannel("!SAFE")).toBe("!safe");
      expect(canonicalChannel("+Modeless")).toBe("+modeless");
    });

    it("does NOT fold the bracket range in sigil-channels — CASEMAPPING=ascii (#525)", () => {
      // #525: bahamut folds ONLY A-Z in channel names; `[ ] \ ~` stay put,
      // so `#chan[1]` and `#chan{1}` are DISTINCT channels (reverses the
      // #364 over-fold). Only case is canonicalised.
      expect(canonicalChannel("#Chan[1]")).toBe("#chan[1]");
      expect(canonicalChannel("#A\\B")).toBe("#a\\b");
      expect(canonicalChannel("#X~Y")).toBe("#x~y");
    });

    it("folds nicks too — no sigil gate (#537, the canonical_target/1 twin)", () => {
      // Contract change (#537): pre-collapse `canonicalChannel` mirrored
      // the sigil-gated `canonical_channel/1` and returned nicks RAW; the
      // server collapsed that into `canonical_target/1` (unconditional
      // A-Z fold). The KEY twin must fold nicks too, else a mixed-case DM
      // window's topic/composite key diverges from the server's folded
      // broadcast. Display + wire keep the original case elsewhere.
      expect(canonicalChannel("Vjt")).toBe("vjt");
      expect(canonicalChannel("CristoBOT")).toBe("cristobot");
      // #525 posture holds for nicks too: only A-Z folds, brackets stay
      // (bahamut keeps `foo[1]`/`foo{1}` DISTINCT).
      expect(canonicalChannel("Foo[1]")).toBe("foo[1]");
    });

    it("leaves $server unchanged (no A-Z to fold)", () => {
      expect(canonicalChannel("$server")).toBe("$server");
    });

    it("is idempotent (a mixed-case nick folds once, stays folded)", () => {
      expect(canonicalChannel(canonicalChannel("#Chan"))).toBe("#chan");
      expect(canonicalChannel(canonicalChannel("Alice"))).toBe("alice");
    });

    it("handles the empty string", () => {
      expect(canonicalChannel("")).toBe("");
    });
  });
});
