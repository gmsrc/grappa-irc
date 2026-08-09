import { describe, expect, it } from "vitest";
import { type Infer, validate, type WireNode } from "../lib/wireValidate";

// #429 — the interpreter for the generated wire schemas. These pin the
// grammar itself; the shapes it is pointed at live in `wireSchema.ts` and are
// pinned by the differential corpus in `wireNarrowAdminCorpus.test.ts`.

describe("validate — scalars", () => {
  it("accepts a string for 's' and rejects every other JSON type", () => {
    expect(validate("s", "x")).toBe("x");
    expect(validate("s", 1)).toBeNull();
    expect(validate("s", null)).toBeNull();
    expect(validate("s", true)).toBeNull();
    expect(validate("s", {})).toBeNull();
  });

  it("accepts a number for 'i', including 0 and negatives", () => {
    expect(validate("i", 0)).toBe(0);
    expect(validate("i", -3)).toBe(-3);
    expect(validate("i", "3")).toBeNull();
  });

  it("accepts a boolean for 'b'", () => {
    expect(validate("b", false)).toBe(false);
    expect(validate("b", "false")).toBeNull();
  });

  it("accepts only null for 'z'", () => {
    expect(validate("z", null)).toBeNull();
    expect(validate("z", "")).toBeNull();
  });

  it("passes anything through for 'x' (the server's own term())", () => {
    expect(validate("x", { anything: [1] })).toEqual({ anything: [1] });
    expect(validate("x", null)).toBeNull();
  });
});

describe("validate — literals and closed sets", () => {
  it("accepts exactly the literal", () => {
    expect(validate({ l: "joined" }, "joined")).toBe("joined");
    expect(validate({ l: "joined" }, "Joined")).toBeNull();
  });

  it("accepts only members of a closed set", () => {
    const node = { e: ["a", "b"] } as const;
    expect(validate(node, "b")).toBe("b");
    expect(validate(node, "c")).toBeNull();
    expect(validate(node, 1)).toBeNull();
  });
});

describe("validate — containers", () => {
  it("rejects the whole array when one element is malformed", () => {
    expect(validate({ a: "s" }, ["a", "b"])).toEqual(["a", "b"]);
    expect(validate({ a: "s" }, ["a", 2])).toBeNull();
    expect(validate({ a: "s" }, "a")).toBeNull();
  });

  it("validates every value of a record", () => {
    expect(validate({ r: "i" }, { a: 1 })).toEqual({ a: 1 });
    expect(validate({ r: "i" }, { a: "1" })).toBeNull();
    expect(validate({ r: "i" }, [])).toBeNull();
  });

  it("requires a tuple to match arity and member types", () => {
    const node = { p: ["s", "i"] } as const;
    expect(validate(node, ["a", 1])).toEqual(["a", 1]);
    expect(validate(node, ["a", 1, 2])).toBeNull();
    expect(validate(node, ["a"])).toBeNull();
  });

  it("takes the first union arm that matches", () => {
    const node = { u: ["s", "z"] } as const;
    expect(validate(node, "a")).toBe("a");
    expect(validate(node, null)).toBeNull();
    expect(validate(node, 1)).toBeNull();
  });
});

describe("validate — objects", () => {
  const node = {
    o: { kind: { l: "ping" }, count: "i", note: "s" },
    q: ["note"],
  } as const;

  it("accepts the declared shape", () => {
    expect(validate(node, { kind: "ping", count: 1, note: "hi" })).toEqual({
      kind: "ping",
      count: 1,
      note: "hi",
    });
  });

  it("accepts an omitted optional key and omits it from the result", () => {
    const out = validate(node, { kind: "ping", count: 1 });
    expect(out).toEqual({ kind: "ping", count: 1 });
    expect(out && "note" in out).toBe(false);
  });

  it("rejects an omitted REQUIRED key", () => {
    expect(validate(node, { kind: "ping", note: "hi" })).toBeNull();
  });

  it("rejects an optional key that is present but wrong-typed", () => {
    expect(validate(node, { kind: "ping", count: 1, note: 7 })).toBeNull();
  });

  it("drops an undeclared key instead of rejecting (additive-only, #447)", () => {
    expect(validate(node, { kind: "ping", count: 1, tomorrows_field: "x" })).toEqual({
      kind: "ping",
      count: 1,
    });
  });

  it("rejects a non-object, an array, and null", () => {
    expect(validate(node, "ping")).toBeNull();
    expect(validate(node, [])).toBeNull();
    expect(validate(node, null)).toBeNull();
  });

  it("rejects a nested object whose inner field is malformed", () => {
    const nested = { o: { inner: { o: { n: "i" } } } } as const;
    expect(validate(nested, { inner: { n: 1 } })).toEqual({ inner: { n: 1 } });
    expect(validate(nested, { inner: { n: "1" } })).toBeNull();
  });
});

describe("Infer", () => {
  it("derives the same shape the schema validates (compile-time)", () => {
    const node = {
      o: { kind: { l: "ping" }, tags: { a: "s" }, slug: { u: ["s", "z"] }, note: "s" },
      q: ["note"],
    } as const;

    // If `Infer` and the interpreter disagreed, one of these two assignments
    // would not compile — that is the whole point of the type.
    const shaped: Infer<typeof node> = {
      kind: "ping",
      tags: ["a"],
      slug: null,
    };
    const parsed = validate(node, shaped);
    expect(parsed).toEqual(shaped);
  });

  it("accepts a union schema as a discriminated union", () => {
    const node = {
      u: [{ o: { kind: { l: "a" }, n: "i" } }, { o: { kind: { l: "b" }, s: "s" } }],
    } as const;

    const parsed = validate(node, { kind: "b", s: "x" });
    expect(parsed).toEqual({ kind: "b", s: "x" });
    if (parsed !== null && parsed.kind === "b") {
      expect(parsed.s).toBe("x");
    }
    expect(validate(node, { kind: "a", n: "1" })).toBeNull();
  });
});

describe("WireNode", () => {
  it("types every arm of the grammar the codegen emits", () => {
    const nodes: WireNode[] = [
      "s",
      "i",
      "b",
      "x",
      "z",
      { l: "k" },
      { e: ["a"] },
      { a: "s" },
      { r: "s" },
      { p: ["s"] },
      { u: ["s", "z"] },
      { o: { a: "s" }, q: ["a"] },
    ];
    expect(nodes).toHaveLength(12);
  });
});
