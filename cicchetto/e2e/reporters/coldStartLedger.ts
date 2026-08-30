// #1584 — the decision half of the cold-start reporter, kept free of any
// Playwright import so `coldStartLedger.test.ts` can prove it without a
// testnet and without a browser.
//
// ## What lies, and why documenting it would not have been enough
//
// The suite runs `workers: 1`, `fullyParallel: false`, three projects. Exactly
// one test per worker pays the browser launch; every later test in that
// worker runs against an already-running browser. So "did this test pay the
// cold start?" is an INPUT to the test — decided by filename sort order plus
// which files the invocation collected — and until now it appeared nowhere in
// the result.
//
// Measured on #1543: `issue310-scroll-to-bottom-btn-cursor.spec.ts`'s @webkit
// test is RED 4/4 as the first `@webkit` test collected, and GREEN the moment
// one other `@webkit` spec sorts before it. A bare open with no assertions is
// red on the same seat. In the full 759-test suite it passes, behind dozens of
// earlier files. Nothing in either report says which side it was measured on.
//
// A green like that cannot be told apart from a green that means the contract
// holds, and a red like that reads as a regression in the branch when it is a
// property of the collected subset. Writing that down in a doc moves the
// problem to a file nobody opens while reading a tick.
//
// ## What this measures, and what it infers
//
// MEASURED: the first test each Playwright worker began, from the reporter's
// own `onTestBegin` stream — which sees every test, including the 29 spec
// files that import `test` from `@playwright/test` instead of the wrapped
// `fixtures/test`. A per-worker counter inside a fixture cannot see those, so
// a subset that puts one of them first would make the next wrapped test read
// as cold when it is not. That false reading is the reason the cure is a
// reporter and not a fixture.
//
// INFERRED: that the worker's first test is the one that paid the browser
// launch. Playwright launches the browser lazily, when a test first asks for
// it, so a hypothetical browser-less first test would push the launch onto its
// successor. No such spec exists today; the inference is named here rather
// than hidden, and the census wording states the measured fact.
//
// ## The two declarations
//
// A spec that knows its outcome depends on this input says so with a tag, and
// the run FAILS when the input does not match the declaration. Undeclared
// specs are never failed by this ledger — they get the census, which is the
// value of the input published next to their result.

/** A spec whose contract is only exercised on its worker's first test. */
export const COLD_START_TAG = "@coldstart";

/** A spec whose outcome is only meaningful when it did NOT pay the launch. */
export const WARM_START_TAG = "@warmstart";

export type StartDeclaration = "cold" | "warm" | "undeclared" | "contradictory";

/** One `onTestBegin`, reduced to the four facts the judgement needs. */
export interface TestStart {
  readonly project: string;
  /** Playwright reports -1 for a test interrupted before it reached a worker. */
  readonly workerIndex: number;
  readonly title: string;
  readonly tags: readonly string[];
}

/** The test a worker began with — the published value of the hidden input. */
export interface CensusRow {
  readonly project: string;
  readonly workerIndex: number;
  readonly title: string;
  readonly declaration: StartDeclaration;
}

export interface RunJudgement {
  readonly census: readonly CensusRow[];
  readonly violations: readonly string[];
}

/**
 * Read a test's declared start temperature off its Playwright tags.
 *
 * Both tags at once is a contradiction, not a precedence puzzle: answering
 * "cold" or "warm" there would pick one silently, which is the same class of
 * quiet wrong answer this whole ledger exists to end.
 */
export function declarationOf(tags: readonly string[]): StartDeclaration {
  const cold = tags.includes(COLD_START_TAG);
  const warm = tags.includes(WARM_START_TAG);
  if (cold && warm) return "contradictory";
  if (cold) return "cold";
  if (warm) return "warm";
  return "undeclared";
}

/**
 * Judge a whole run from its `onTestBegin` stream, in arrival order.
 *
 * Per WORKER, not per run: worker 1 launches its own browser however many
 * tests worker 0 has already run, so a run-wide counter would clear a promoted
 * spec in the second project.
 */
export function judgeRun(starts: readonly TestStart[]): RunJudgement {
  const heads = new Map<number, TestStart>();
  const violations: string[] = [];

  for (const started of starts) {
    // A test that never reached a worker launched nothing, and must not be
    // recorded as the payer — the next test in that worker is the real one.
    if (started.workerIndex < 0) continue;

    const head = heads.get(started.workerIndex);
    const paidColdStart = head === undefined;
    if (paidColdStart) heads.set(started.workerIndex, started);

    const violation = violationOf(started, paidColdStart, head);
    if (violation) violations.push(violation);
  }

  const census = [...heads.values()].map(
    (head): CensusRow => ({
      project: head.project,
      workerIndex: head.workerIndex,
      title: head.title,
      declaration: declarationOf(head.tags),
    }),
  );

  return { census, violations };
}

function violationOf(
  started: TestStart,
  paidColdStart: boolean,
  head: TestStart | undefined,
): string | null {
  const where = `project ${started.project}, worker ${started.workerIndex}`;

  switch (declarationOf(started.tags)) {
    case "contradictory":
      return (
        `${started.title} carries both ${COLD_START_TAG} and ${WARM_START_TAG}. ` +
        "A test declares one start temperature or none (#1584)."
      );

    case "cold":
      if (paidColdStart) return null;
      return (
        `${started.title} declares ${COLD_START_TAG} but did not pay the cold start. ` +
        `${where} began with: ${head?.title}. The contract this spec names is only ` +
        "exercised on the worker's first test, so a green here would not be evidence " +
        "that it holds (#1584)."
      );

    case "warm":
      if (!paidColdStart) return null;
      return (
        `${started.title} declares ${WARM_START_TAG} but paid the cold start. ` +
        `${where} began with it, so it took the browser launch it does not take in ` +
        "the full suite. Its outcome here is a property of the collected subset, not " +
        "of the branch under test (#1584, #1543)."
      );

    case "undeclared":
      return null;
  }
}
