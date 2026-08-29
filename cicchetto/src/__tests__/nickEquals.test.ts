import { describe, expect, it } from "vitest";
import { asciiFold, nickEquals, normalizeNick } from "../lib/nickEquals";

// #525 — ONE client nick fold, pinned to the server. `asciiFold` is the
// single client-side fold and must stay byte-for-byte with
// `Grappa.IRC.Identifier.canonical_nick/1` (bahamut is CASEMAPPING=ascii:
// A-Z only). This enumerated table is the drift gate: a server-side fold
// change (or an accidental Unicode / bracket regression) makes it go RED
// loudly, exactly like `nick_fold_sql/1`'s migration pin does server-side.
describe("asciiFold — single client fold, mirror of server canonical_nick/1", () => {
  it("folds A-Z to a-z", () => {
    expect(asciiFold("ABCDEFGHIJKLMNOPQRSTUVWXYZ")).toBe("abcdefghijklmnopqrstuvwxyz");
  });

  it("does NOT fold [ ] \\ ~ — bahamut is CASEMAPPING=ascii (#525)", () => {
    // Reverses the #364 over-fold: these are DISTINCT to the ircd.
    expect(asciiFold("[")).toBe("[");
    expect(asciiFold("]")).toBe("]");
    expect(asciiFold("\\")).toBe("\\");
    expect(asciiFold("~")).toBe("~");
  });

  it("leaves brace/pipe/caret, digits and punctuation untouched", () => {
    expect(asciiFold("{}|^")).toBe("{}|^");
    expect(asciiFold("0-9_a")).toBe("0-9_a");
  });

  it("is ASCII-byte-level: does NOT Unicode-fold non-ASCII", () => {
    expect(asciiFold("CAFÉ")).toBe("cafÉ");
    expect(asciiFold("İ")).toBe("İ");
  });

  it("is idempotent", () => {
    const once = asciiFold("Foo[Bar]~Baz\\");
    expect(asciiFold(once)).toBe(once);
  });
});

// #1861 — the per-network half. `normalizeNick`/`nickEquals` now take the
// network's advertised CASEMAPPING and fold the four "national" characters
// accordingly, mirroring the server's `Identifier.normalize_casemapping/2`
// + `canonical_target/2` composition. The table below is the drift gate
// against `national_byte/2`; the `:ascii` rows are the #525 posture and
// MUST keep `[ ] \ ~` distinct from `{ } | ^`, because that is what
// bahamut/Azzurra — all of production — implements.
describe("normalizeNick — per-casemapping fold (#1861)", () => {
  describe("ascii (bahamut / Azzurra — all of production)", () => {
    it("lower-cases ASCII", () => {
      expect(normalizeNick("Alice", "ascii")).toBe("alice");
      expect(normalizeNick("VJT-Grappa", "ascii")).toBe("vjt-grappa");
    });

    // #525 — case folds, the bracket range does NOT (mirrors the ircd's
    // CASEMAPPING=ascii). Reversing this breaks Azzurra.
    it("folds case only, not the bracket range", () => {
      expect(normalizeNick("Foo[1]", "ascii")).toBe("foo[1]");
      expect(normalizeNick("A\\B~C", "ascii")).toBe("a\\b~c");
    });

    it("is idempotent", () => {
      const once = normalizeNick("Alice", "ascii");
      expect(normalizeNick(once, "ascii")).toBe(once);
    });
  });

  describe("rfc1459 (solanum / Rizon — `[ ] \\ ~` fold to `{ } | ^`)", () => {
    it("folds the full national set alongside A-Z", () => {
      expect(normalizeNick("Foo[1]", "rfc1459")).toBe("foo{1}");
      expect(normalizeNick("A\\B~C", "rfc1459")).toBe("a|b^c");
      expect(normalizeNick("[EWG]-L0VE", "rfc1459")).toBe("{ewg}-l0ve");
    });

    it("leaves the fold TARGETS alone, so it is idempotent", () => {
      expect(normalizeNick("{ewg}-l0ve", "rfc1459")).toBe("{ewg}-l0ve");
      const once = normalizeNick("Foo[Bar]~Baz\\", "rfc1459");
      expect(normalizeNick(once, "rfc1459")).toBe(once);
    });

    it("is byte-level: does NOT Unicode-fold non-ASCII", () => {
      expect(normalizeNick("CAFÉ", "rfc1459")).toBe("cafÉ");
    });
  });

  describe("rfc1459_strict (the bracket trio only — RFC 1459 predates the tilde rule)", () => {
    it("folds [ ] \\ but leaves ~ alone", () => {
      expect(normalizeNick("A\\B~C", "rfc1459_strict")).toBe("a|b~c");
      expect(normalizeNick("Foo[1]", "rfc1459_strict")).toBe("foo{1}");
      expect(normalizeNick("x~y", "rfc1459_strict")).toBe("x~y");
    });
  });
});

describe("nickEquals", () => {
  it("returns true for casing variants", () => {
    expect(nickEquals("Alice", "alice", "ascii")).toBe(true);
    expect(nickEquals("alice", "ALICE", "ascii")).toBe(true);
    expect(nickEquals("VjT-Grappa", "vjt-grappa", "ascii")).toBe(true);
  });

  it("returns true for identical nicks", () => {
    expect(nickEquals("alice", "alice", "ascii")).toBe(true);
  });

  // #525 — case folds, but bracket-vs-brace does NOT: `foo[1]` and
  // `foo{1}` are DISTINCT nicks to the ircd (CASEMAPPING=ascii), so cic
  // keeps them apart too (reverses the #364 over-fold that merged them).
  it("keeps bracket-vs-brace nicks distinct on :ascii, folds case only", () => {
    expect(nickEquals("Foo[1]", "foo[1]", "ascii")).toBe(true);
    expect(nickEquals("Foo[1]", "foo{1}", "ascii")).toBe(false);
    expect(nickEquals("a\\b", "a|b", "ascii")).toBe(false);
    expect(nickEquals("x~y", "x^y", "ascii")).toBe(false);
  });

  // #1861 — the SAME pair on an rfc1459 network is ONE person. This is the
  // reported symptom: `[EWG]-L0VE` and `{ewg}-l0ve` on Rizon.
  it("collapses bracket-vs-brace nicks on :rfc1459", () => {
    expect(nickEquals("Foo[1]", "foo{1}", "rfc1459")).toBe(true);
    expect(nickEquals("[EWG]-L0VE", "{ewg}-l0ve", "rfc1459")).toBe(true);
    expect(nickEquals("a\\b", "a|b", "rfc1459")).toBe(true);
    expect(nickEquals("x~y", "x^y", "rfc1459")).toBe(true);
  });

  it("keeps ~ apart on :rfc1459_strict while folding the bracket trio", () => {
    expect(nickEquals("Foo[1]", "foo{1}", "rfc1459_strict")).toBe(true);
    expect(nickEquals("a\\b", "a|b", "rfc1459_strict")).toBe(true);
    expect(nickEquals("x~y", "x^y", "rfc1459_strict")).toBe(false);
  });

  it("returns false for distinct nicks", () => {
    expect(nickEquals("alice", "bob", "ascii")).toBe(false);
    expect(nickEquals("vjt", "vjt-grappa", "ascii")).toBe(false);
    expect(nickEquals("alice", "bob", "rfc1459")).toBe(false);
  });

  it("returns false when either side is null/undefined", () => {
    expect(nickEquals(null, "alice", "ascii")).toBe(false);
    expect(nickEquals("alice", null, "ascii")).toBe(false);
    expect(nickEquals(null, null, "ascii")).toBe(false);
    expect(nickEquals(undefined, "alice", "ascii")).toBe(false);
    expect(nickEquals("alice", undefined, "ascii")).toBe(false);
  });
});
