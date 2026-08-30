import { afterEach, describe, expect, it, vi } from "vitest";
import { frameBudgetForTarget, frameCount, framePreview, utf8ByteLength } from "../lib/frameBudget";

// #1108 — the compose box warns, BEFORE sending, that the draft no longer
// fits one IRC frame. Two numbers drive that: how many bytes are left in the
// frame, and how many messages the draft would become.
//
// The BUDGET is not computed here — the server publishes it
// (`frame_budget_base` on `isupport_changed`), because it reserves the #246
// worst-case relayed source prefix and a client-side copy of those ceilings
// drifts in the direction that loses bytes.
//
// The COUNT is a mirror of `Grappa.IRC.LineSplit`'s chunker, and the cases
// below are written against the WORD-BOUNDARY semantics (#1109): the cut
// prefers the last ASCII space/tab at or before the budget, and the boundary
// grapheme is CONSUMED. `wordBoundaryBody` is the one that a naive byte cut
// gets wrong — it is the reason this file exists rather than a ceil() call.
//
// Every (budget, body) below appears VERBATIM in the server's own table,
// `test/grappa/irc/line_split_test.exs` → "#1108: the fragment counts cic's
// preview mirrors". That pairing is what keeps the mirror a mirror: change
// either splitter and its own suite goes red. Add a case here, add it there.

// budget 10, "aaaaa bbbbbbbb cc" (17 bytes):
//   byte cut  → "aaaaa bbbb" | "bbbb cc"                        = 2
//   word cut  → "aaaaa" | "bbbbbbbb" | "cc"                     = 3
const wordBoundaryBody = "aaaaa bbbbbbbb cc";

describe("frameBudget — utf8ByteLength", () => {
  // The count is in UTF-8 BYTES, never UTF-16 units: a draft of accented
  // text or emoji splits well before its character count suggests. Pinned
  // against the platform encoder so the hand-rolled walk cannot drift.
  const corpus = [
    "",
    "plain ascii",
    "café",
    "naïve résumé",
    "日本語のテキスト",
    "🍕🍕🍕",
    "👩‍👩‍👧‍👦",
    "é combining",
    " nbsp",
    "\x01ACTION waves\x01",
  ];

  for (const s of corpus) {
    it(`agrees with TextEncoder for ${JSON.stringify(s)}`, () => {
      expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).length);
    });
  }
});

describe("frameBudget — frameBudgetForTarget", () => {
  it("subtracts the target's UTF-8 byte length from the published base", () => {
    expect(frameBudgetForTarget(400, "#sniffo")).toBe(393);
  });

  it("charges a multibyte target its BYTES, not its characters", () => {
    // "#café" is 5 characters but 6 bytes; budgeting by character length
    // would over-promise by exactly the bytes the wire actually spends.
    expect(frameBudgetForTarget(400, "#café")).toBe(394);
  });

  it("has no budget to report when the frame cannot hold a body at all", () => {
    // A LINELEN small enough to be eaten whole by the relay reserve makes
    // the base negative, and the server's own fast path then sends the body
    // UNSPLIT. There is nothing to warn about and nothing to count down —
    // and a negative "remaining" would render as `--118`.
    expect(frameBudgetForTarget(-118, "#a")).toBeNull();
    expect(frameBudgetForTarget(2, "#ab")).toBeNull();
  });
});

describe("frameBudget — frameCount", () => {
  it("counts a body that exactly fills the budget as one frame", () => {
    expect(frameCount("a".repeat(10), 10)).toBe(1);
  });

  it("counts one byte past the budget as two frames", () => {
    expect(frameCount("a".repeat(11), 10)).toBe(2);
  });

  it("breaks at the last word boundary and consumes it (#1109)", () => {
    expect(frameCount(wordBoundaryBody, 10)).toBe(3);
  });

  it("treats a tab as a word boundary, like the server", () => {
    expect(frameCount("aaaaa\tbbbbbbbb cc", 10)).toBe(3);
  });

  it("does not break on a boundary that would emit an empty fragment", () => {
    // The chunk's only whitespace is its FIRST grapheme, so breaking there
    // would emit nothing and carry everything — the server falls back to the
    // byte cut instead. Without this case a `k >= 0` off-by-one in the
    // boundary scan passes the whole suite.
    expect(frameCount(` ${"a".repeat(12)}`, 10)).toBe(2);
  });

  it("keeps a multi-codepoint grapheme cluster whole", () => {
    // The server splits on `String.graphemes/1` — EXTENDED grapheme
    // clusters. A ZWJ family is 25 bytes and ONE of those; counting code
    // points instead would report seven frames for a single indivisible
    // one. This is the one place the two runtimes' segmentation tables
    // have to agree, and 🍕 (a lone codepoint) does not exercise it.
    expect(frameCount("👩‍👩‍👧‍👦", 4)).toBe(1);
  });

  it("falls back to the byte cut for a token with no boundary in it", () => {
    // A URL / base64 blob / CJK wall must still split rather than loop.
    expect(frameCount("a".repeat(20), 10)).toBe(2);
  });

  it("emits a single grapheme larger than the budget as its own frame", () => {
    expect(frameCount("🍕🍕", 2)).toBe(2);
  });

  it("measures multibyte text in bytes", () => {
    expect(frameCount("é".repeat(5), 10)).toBe(1);
    expect(frameCount("é".repeat(6), 10)).toBe(2);
  });

  it("charges the CTCP ACTION envelope on every fragment", () => {
    // Envelope is 10 bytes, so a budget of 20 leaves 10 for the inner text.
    const inner = "a".repeat(15);
    expect(frameCount(`\x01ACTION ${inner}\x01`, 20)).toBe(2);
    // …and the same 15 bytes as a PLAIN body fit the same budget whole.
    expect(frameCount(inner, 20)).toBe(1);
  });

  it("gives up on a budget too small to frame anything", () => {
    // Mirrors the server's non-positive-budget fast path: one body, unsplit.
    expect(frameCount("hello", 0)).toBe(1);
    expect(frameCount(`\x01ACTION hello\x01`, 5)).toBe(1);
  });
});

describe("frameBudget — framePreview", () => {
  it("reports one message and the bytes left while the draft still fits", () => {
    expect(framePreview(["hello"], 10)).toEqual({ messages: 1, remainingBytes: 5 });
  });

  it("reports zero bytes left at the exact edge, still one message", () => {
    expect(framePreview(["a".repeat(10)], 10)).toEqual({ messages: 1, remainingBytes: 0 });
  });

  it("drops the countdown once the draft no longer fits one frame", () => {
    // Past the edge the seam warning takes over: a "bytes remaining" number
    // for a body that has already split would be about nothing.
    expect(framePreview([wordBoundaryBody], 10)).toEqual({ messages: 3, remainingBytes: null });
  });

  it("sums the frames of a multi-line draft and shows no countdown", () => {
    // Newline splitting is the client's half (user intent, messageLines.ts);
    // length splitting is the server's. The operator is owed the total.
    expect(framePreview(["short", "a".repeat(11)], 10)).toEqual({
      messages: 3,
      remainingBytes: null,
    });
  });

  it("reports nothing to send for an empty draft", () => {
    expect(framePreview([], 10)).toEqual({ messages: 0, remainingBytes: null });
  });
});

// #1870 — `Intl.Segmenter` landed in Firefox 125, and this module used to
// construct one at TOP LEVEL. `ComposeBox` imports `frameBudgetForTarget`, so
// on Firefox 115 ESR the `TypeError` fired while the main bundle was still
// evaluating: nothing mounted, and a frame counter cost the whole app a WHITE
// PAGE. The build target (`es2022`, vite.config.ts) cannot catch that —
// `Intl.Segmenter` is a LIBRARY feature, not syntax, so no transpile step
// ever looks at it.
//
// Two properties, deliberately separate: the module must EVALUATE where the
// API is absent, and its one segmenting call site must still answer a
// defensible number.
//
// ⚠️ What these tests do NOT prove: that Firefox 115 renders the page. There
// is no FF115 here and Playwright ships no build of it, so the white page
// itself stays a diagnosis from the stack trace in the report, never an
// observation. What is pinned is the code-level property that diagnosis
// names, in the only runtime this repo has.
describe("frameBudget — where Intl.Segmenter is absent (#1870)", () => {
  const realSegmenter = Intl.Segmenter;

  // The pairs where the fallback and the segmenter DISAGREE, stated together
  // so the price of the fallback is one table rather than a claim: a code
  // point is not a grapheme, and these are the two ways that shows.
  const divergences = [
    {
      what: "a combining sequence",
      // "e" + U+0301 is ONE 3-byte grapheme, so at a 2-byte budget the
      // segmenter emits it whole as its own oversized frame; the fallback
      // sees a 1-byte "e" and a 2-byte mark and breaks between them.
      // Written as an ESCAPE, never as a literal: an editor that stores the
      // precomposed U+00E9 instead makes this 2 bytes, which fits the budget
      // whole — both paths would then answer 1 and agree for the wrong reason.
      body: "e\u0301",
      budget: 2,
      withSegmenter: 1,
      fallback: 2,
    },
    {
      what: "a ZWJ emoji cluster",
      // 25 bytes, ONE grapheme — and seven code points (four emoji, three
      // joiners), which at a 4-byte budget is seven frames.
      body: "👩‍👩‍👧‍👦",
      budget: 4,
      withSegmenter: 1,
      fallback: 7,
    },
  ] as const;

  afterEach(() => {
    Object.defineProperty(Intl, "Segmenter", {
      value: realSegmenter,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    vi.resetModules();
  });

  // A module instance that has NEVER seen the constructor — the state an
  // FF115 tab boots in, as opposed to one that lost it half way through.
  async function importWithoutSegmenter() {
    vi.resetModules();
    Reflect.deleteProperty(Intl, "Segmenter");
    // The removal is the premise of every assertion below: if the property
    // were not configurable, these tests would pass while measuring the
    // segmenter path.
    expect(Intl.Segmenter).toBeUndefined();
    return import("../lib/frameBudget");
  }

  it("evaluates instead of throwing while the bundle is loading", async () => {
    const module = await importWithoutSegmenter();
    expect(typeof module.frameCount).toBe("function");
  });

  it("keeps a surrogate pair whole in the fallback split", async () => {
    const { frameCount: countWithout } = await importWithoutSegmenter();
    // `Array.from` iterates CODE POINTS, so each 4-byte pizza stays one unit
    // and two of them at a 4-byte budget are two frames — the same answer the
    // segmenter gives. A UTF-16 unit walk would see four 3-byte lone
    // surrogates and report FOUR, which is what this case exists to reject.
    expect(countWithout("🍕🍕", 4)).toBe(2);
    expect(frameCount("🍕🍕", 4)).toBe(2);
  });

  for (const example of divergences) {
    it(`splits ${example.what} the segmenter would have kept whole`, async () => {
      const { frameCount: countWithout } = await importWithoutSegmenter();
      // DECLARED WRONG, deliberately. It costs an advisory COUNT and never a
      // byte — the split that reaches the wire is still the server's — and
      // only on a browser that cannot segment at all. The alternative was
      // shipping no number there, or no app at all.
      expect(countWithout(example.body, example.budget)).toBe(example.fallback);
      expect(example.fallback).not.toBe(example.withSegmenter);
    });
  }

  it("is byte-for-byte unchanged where the segmenter exists", async () => {
    vi.resetModules();
    // Positive control: this arm is only meaningful while the constructor is
    // really there, and `afterEach` above is what put it back.
    expect(typeof Intl.Segmenter).toBe("function");
    const { frameCount: countWith } = await import("../lib/frameBudget");
    for (const example of divergences) {
      expect(countWith(example.body, example.budget)).toBe(example.withSegmenter);
    }
  });
});
