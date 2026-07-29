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

describe("normalizeNick", () => {
  it("lower-cases ASCII", () => {
    expect(normalizeNick("Alice")).toBe("alice");
    expect(normalizeNick("VJT-Grappa")).toBe("vjt-grappa");
  });

  // #525 — normalizeNick is layered on asciiFold: case folds, the bracket
  // range does NOT (mirrors the ircd's CASEMAPPING=ascii).
  it("folds case only, not the bracket range", () => {
    expect(normalizeNick("Foo[1]")).toBe("foo[1]");
    expect(normalizeNick("A\\B~C")).toBe("a\\b~c");
  });

  it("is idempotent", () => {
    const once = normalizeNick("Alice");
    expect(normalizeNick(once)).toBe(once);
  });
});

describe("nickEquals", () => {
  it("returns true for casing variants", () => {
    expect(nickEquals("Alice", "alice")).toBe(true);
    expect(nickEquals("alice", "ALICE")).toBe(true);
    expect(nickEquals("VjT-Grappa", "vjt-grappa")).toBe(true);
  });

  it("returns true for identical nicks", () => {
    expect(nickEquals("alice", "alice")).toBe(true);
  });

  // #525 — case folds, but bracket-vs-brace does NOT: `foo[1]` and
  // `foo{1}` are DISTINCT nicks to the ircd (CASEMAPPING=ascii), so cic
  // keeps them apart too (reverses the #364 over-fold that merged them).
  it("keeps bracket-vs-brace nicks distinct, folds case only", () => {
    expect(nickEquals("Foo[1]", "foo[1]")).toBe(true);
    expect(nickEquals("Foo[1]", "foo{1}")).toBe(false);
    expect(nickEquals("a\\b", "a|b")).toBe(false);
    expect(nickEquals("x~y", "x^y")).toBe(false);
  });

  it("returns false for distinct nicks", () => {
    expect(nickEquals("alice", "bob")).toBe(false);
    expect(nickEquals("vjt", "vjt-grappa")).toBe(false);
  });

  it("returns false when either side is null/undefined", () => {
    expect(nickEquals(null, "alice")).toBe(false);
    expect(nickEquals("alice", null)).toBe(false);
    expect(nickEquals(null, null)).toBe(false);
    expect(nickEquals(undefined, "alice")).toBe(false);
    expect(nickEquals("alice", undefined)).toBe(false);
  });
});
