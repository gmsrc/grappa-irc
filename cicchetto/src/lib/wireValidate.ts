// #429 — the interpreter for the generated runtime wire schemas.
//
// ## Why this exists
//
// `wireTypes.ts` is the codegen mirror of the server's `Grappa.*.Wire`
// typespecs, and `tsc` erases every line of it. So the only thing actually
// standing at the WS/REST boundary was `wireNarrow.ts` + `wireTypesAssert.ts`
// + the inline narrowers in `api.ts` — ~1250 hand-written lines
// re-transcribing, by hand, the very typespecs the codegen already reads.
// Two hand-maintained copies of one authoritative source; the hand copy is
// the one that can silently lose an arm (and did — see `web_session_severed`
// in `wireNarrow.ts`'s history).
//
// `wireSchema.ts` emits those same typespecs as runtime data. This module is
// the ~100 lines that read it. A new server-side Wire type therefore arrives
// with its runtime validation already written.
//
// ## What it does NOT decide
//
// A narrower is not just types — it is the defence at the boundary, and part
// of that defence is a judgement call the typespec cannot express:
//
//   * a DEFAULT that rescues an event instead of dropping it (an unknown
//     `window_counts.severity` must not null the counts);
//   * a TOLERANCE toward a payload minted by a peer of a different vintage
//     (cic deploys independently of the server);
//   * whether a given arm is load-bearing or a detail.
//
// Those stay hand-written at the call site, named as policy. What this file
// removes is the mechanical part: field presence, primitive kinds, closed
// sets, nullability, arrays, nesting. See the per-call-site notes in
// `wireNarrow.ts`.
//
// ## The additive-only contract
//
// An object node copies ONLY the fields the schema declares and ignores
// every other key. An unknown field is never fatal, in either direction —
// that is the wire contract (CLAUDE.md, GH #447), and it is enforced here
// once rather than re-argued in each hand-written arm.

/**
 * A node of the generated schema grammar. Mirrors the emission in
 * `Mix.Tasks.Grappa.GenWireTypes.schema_ir/2` — change one, change both
 * (the codegen's own moduledoc carries the same grammar).
 */
export type WireNode =
  | "s"
  | "i"
  | "b"
  | "x"
  | "z"
  | { readonly l: string | boolean }
  | { readonly e: readonly string[] }
  | { readonly a: WireNode }
  | { readonly r: WireNode }
  | { readonly p: readonly WireNode[] }
  | { readonly u: readonly WireNode[] }
  | { readonly o: { readonly [key: string]: WireNode }; readonly q?: readonly string[] };

/**
 * The TypeScript type a schema node validates to. Lets a call site assert —
 * at compile time — that the schema it validates against and the generated
 * type it claims to produce are the same shape. Both come out of one codegen
 * run, so a mismatch means the interpreter drifted from the emitter, and
 * that is exactly what the assert is for.
 */
export type Infer<N, D extends Depth = 9> = [D] extends [never]
  ? unknown
  : N extends "s"
    ? string
    : N extends "i"
      ? number
      : N extends "b"
        ? boolean
        : N extends "x"
          ? unknown
          : N extends "z"
            ? null
            : N extends { l: infer L }
              ? L
              : N extends { e: readonly (infer E)[] }
                ? E
                : N extends { a: infer A }
                  ? Infer<A, Prev[D]>[]
                  : N extends { r: infer R }
                    ? Record<string, Infer<R, Prev[D]>>
                    : N extends { p: infer P extends readonly unknown[] }
                      ? { -readonly [K in keyof P]: Infer<P[K], Prev[D]> }
                      : N extends { u: readonly (infer U)[] }
                        ? Infer<U, Prev[D]>
                        : N extends { o: infer O; q: readonly (infer Q extends string)[] }
                          ? InferObject<O, Q, Prev[D]>
                          : N extends { o: infer O }
                            ? InferObject<O, never, Prev[D]>
                            : never;

// `WireNode` is recursive, so `Infer<N>` under an `N extends WireNode`
// constraint is too (TS2589 — "excessively deep"). The fuel counter bounds
// it. Nine levels is far past anything a JSON wire shape reaches; a schema
// that hit the floor would degrade to `unknown` at the leaf rather than fail
// to compile, and the runtime walk is unaffected either way.
type Depth = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8];

type InferObject<O, Q extends string, D extends Depth> = {
  -readonly [K in Exclude<keyof O, Q>]: Infer<O[K], D>;
} & {
  -readonly [K in Extract<keyof O, Q>]?: Infer<O[K], D>;
};

// `null` is a legal validated value (`"z"`, and every `T | null` field), so
// failure cannot be signalled with it. A module-private sentinel keeps the
// public surface at one function returning `T | null`, which is the shape
// every existing narrower already speaks.
const REJECT = Symbol("wireValidate.reject");

/**
 * Validate `raw` against a generated schema node.
 *
 * Returns the value typed as the schema describes, or `null` when the payload
 * does not match. Top-level wire shapes are objects (or unions of objects),
 * so `null` is unambiguous there; a nested nullable field is handled inside
 * the walk, where the sentinel keeps the two apart.
 */
export function validate<const N extends WireNode>(node: N, raw: unknown): Infer<N> | null {
  const out = walk(node, raw);
  return out === REJECT ? null : (out as Infer<N>);
}

function walk(node: WireNode, raw: unknown): unknown | typeof REJECT {
  if (typeof node === "string") return walkScalar(node, raw);
  if ("l" in node) return raw === node.l ? raw : REJECT;
  if ("e" in node) return typeof raw === "string" && node.e.includes(raw) ? raw : REJECT;
  if ("a" in node) return walkArray(node.a, raw);
  if ("r" in node) return walkRecord(node.r, raw);
  if ("p" in node) return walkTuple(node.p, raw);
  if ("u" in node) return walkUnion(node.u, raw);
  return walkObject(node.o, node.q, raw);
}

function walkScalar(node: "s" | "i" | "b" | "x" | "z", raw: unknown): unknown | typeof REJECT {
  switch (node) {
    case "s":
      return typeof raw === "string" ? raw : REJECT;
    case "i":
      return typeof raw === "number" ? raw : REJECT;
    case "b":
      return typeof raw === "boolean" ? raw : REJECT;
    case "z":
      return raw === null ? null : REJECT;
    // `term()` on the server — the field is carried through unvalidated
    // BECAUSE the typespec declines to describe it, not as a shortcut.
    case "x":
      return raw;
  }
}

function walkArray(inner: WireNode, raw: unknown): unknown | typeof REJECT {
  if (!Array.isArray(raw)) return REJECT;
  const out: unknown[] = [];
  for (const el of raw) {
    const v = walk(inner, el);
    if (v === REJECT) return REJECT;
    out.push(v);
  }
  return out;
}

function walkRecord(inner: WireNode, raw: unknown): unknown | typeof REJECT {
  if (!isPlainObject(raw)) return REJECT;
  const out: Record<string, unknown> = {};
  for (const [k, el] of Object.entries(raw)) {
    const v = walk(inner, el);
    if (v === REJECT) return REJECT;
    out[k] = v;
  }
  return out;
}

function walkTuple(members: readonly WireNode[], raw: unknown): unknown | typeof REJECT {
  if (!Array.isArray(raw) || raw.length !== members.length) return REJECT;
  const out: unknown[] = [];
  for (let i = 0; i < members.length; i++) {
    const v = walk(members[i] as WireNode, raw[i]);
    if (v === REJECT) return REJECT;
    out.push(v);
  }
  return out;
}

// First matching arm wins. Every discriminated union the codegen emits leads
// each arm with its `kind` literal, so a mismatched arm fails on its first
// field and the scan is cheap; an ambiguous union would be a server-side
// modelling bug, not something to resolve by scoring arms here.
function walkUnion(arms: readonly WireNode[], raw: unknown): unknown | typeof REJECT {
  for (const arm of arms) {
    const v = walk(arm, raw);
    if (v !== REJECT) return v;
  }
  return REJECT;
}

function walkObject(
  fields: { readonly [key: string]: WireNode },
  optional: readonly string[] | undefined,
  raw: unknown,
): unknown | typeof REJECT {
  if (!isPlainObject(raw)) return REJECT;
  const out: Record<string, unknown> = {};
  for (const [key, fieldNode] of Object.entries(fields)) {
    const present = raw[key];
    if (present === undefined) {
      // An `optional(:k)` key the server may omit. A REQUIRED key that is
      // absent is a shape mismatch, not a tolerance: the typespec is where
      // the server says which is which.
      if (optional?.includes(key)) continue;
      return REJECT;
    }
    const v = walk(fieldNode, present);
    if (v === REJECT) return REJECT;
    out[key] = v;
  }
  // Undeclared keys are dropped, never rejected — additive-only (GH #447).
  return out;
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
