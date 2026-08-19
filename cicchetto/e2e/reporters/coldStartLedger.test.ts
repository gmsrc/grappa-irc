// #1584 — the ledger IS the cure, so it has to be able to fail for the right
// reason, and only for that reason. Runs under the cic vitest project (same
// reason and same shape as `fixtures/pushAbsence.test.ts`): the logic is
// deliberately free of any Playwright import, so it is provable without a
// testnet and without a browser.
//
// The case that matters is the one MEASURED on #1543: a spec whose outcome
// depends on paying the cold browser launch goes GREEN the moment any other
// spec sorts before it in the same project, and nothing in the report says
// the condition changed. A green like that is indistinguishable, to a reader,
// from a green that means the contract holds.

import { describe, expect, it } from "vitest";
import {
  COLD_START_TAG,
  declarationOf,
  judgeRun,
  type TestStart,
  WARM_START_TAG,
} from "./coldStartLedger";

function start(overrides: Partial<TestStart> & Pick<TestStart, "title">): TestStart {
  return {
    project: "webkit-iphone-15",
    workerIndex: 0,
    tags: [],
    ...overrides,
  };
}

describe("declarationOf", () => {
  it("reads @coldstart as a declared dependency on the cold start", () => {
    expect(declarationOf([COLD_START_TAG])).toBe("cold");
  });

  it("reads @warmstart as a declared dependency on NOT paying the cold start", () => {
    expect(declarationOf([WARM_START_TAG])).toBe("warm");
  });

  it("reads an unrelated tag as undeclared", () => {
    expect(declarationOf(["@webkit"])).toBe("undeclared");
  });

  it("reads both tags together as contradictory rather than picking one", () => {
    expect(declarationOf([WARM_START_TAG, COLD_START_TAG])).toBe("contradictory");
  });
});

describe("judgeRun census", () => {
  it("names the first test each worker began, which is the one that paid the launch", () => {
    const judgement = judgeRun([
      start({ title: "first here", workerIndex: 0 }),
      start({ title: "second here", workerIndex: 0 }),
    ]);

    expect(judgement.census).toEqual([
      {
        project: "webkit-iphone-15",
        workerIndex: 0,
        title: "first here",
        declaration: "undeclared",
      },
    ]);
  });

  it("keeps one row per worker, so a second project does not overwrite the first", () => {
    const judgement = judgeRun([
      start({ title: "chromium head", project: "chromium", workerIndex: 0 }),
      start({ title: "webkit head", project: "webkit-iphone-15", workerIndex: 1 }),
      start({ title: "webkit tail", project: "webkit-iphone-15", workerIndex: 1 }),
    ]);

    expect(judgement.census.map((row) => row.title)).toEqual(["chromium head", "webkit head"]);
  });

  it("ignores a test that never reached a worker, so it cannot be read as the payer", () => {
    // Playwright reports workerIndex -1 for a test interrupted before it ran
    // (testReporter.d.ts). Such a test launched nothing.
    const judgement = judgeRun([
      start({ title: "interrupted", workerIndex: -1 }),
      start({ title: "really ran", workerIndex: 0 }),
    ]);

    expect(judgement.census.map((row) => row.title)).toEqual(["really ran"]);
  });

  it("reports an empty census for a run that began no test", () => {
    expect(judgeRun([])).toEqual({ census: [], violations: [] });
  });
});

describe("judgeRun violations", () => {
  it("fails a @coldstart test that another test preceded in its worker", () => {
    const judgement = judgeRun([
      start({ title: "unrelated spec" }),
      start({ title: "needs the cold start", tags: [COLD_START_TAG] }),
    ]);

    expect(judgement.violations).toHaveLength(1);
    expect(judgement.violations[0]).toContain("needs the cold start");
    expect(judgement.violations[0]).toContain(COLD_START_TAG);
    // The payer is named: without it the reader cannot tell WHAT silenced it.
    expect(judgement.violations[0]).toContain("unrelated spec");
  });

  it("passes a @coldstart test that its worker began with", () => {
    const judgement = judgeRun([
      start({ title: "needs the cold start", tags: [COLD_START_TAG] }),
      start({ title: "unrelated spec" }),
    ]);

    expect(judgement.violations).toEqual([]);
  });

  it("fails a @warmstart test the invocation promoted to its worker's first", () => {
    const judgement = judgeRun([
      start({ title: "only evidence when warm", tags: [WARM_START_TAG] }),
      start({ title: "unrelated spec" }),
    ]);

    expect(judgement.violations).toHaveLength(1);
    expect(judgement.violations[0]).toContain("only evidence when warm");
    expect(judgement.violations[0]).toContain(WARM_START_TAG);
  });

  it("passes a @warmstart test that ran behind another test in its worker", () => {
    const judgement = judgeRun([
      start({ title: "unrelated spec" }),
      start({ title: "only evidence when warm", tags: [WARM_START_TAG] }),
    ]);

    expect(judgement.violations).toEqual([]);
  });

  it("judges each worker on its own head, not on the run's first test", () => {
    // Worker 0 ran two tests already; that says nothing about worker 1, which
    // launched its own browser. A per-run counter would pass this wrongly.
    const judgement = judgeRun([
      start({ title: "chromium head", project: "chromium", workerIndex: 0 }),
      start({ title: "chromium tail", project: "chromium", workerIndex: 0 }),
      start({
        title: "only evidence when warm",
        project: "webkit-iphone-15",
        workerIndex: 1,
        tags: [WARM_START_TAG],
      }),
    ]);

    expect(judgement.violations).toHaveLength(1);
    expect(judgement.violations[0]).toContain("only evidence when warm");
  });

  it("fails a contradictory declaration wherever it ran", () => {
    const judgement = judgeRun([
      start({ title: "unrelated spec" }),
      start({ title: "says both", tags: [COLD_START_TAG, WARM_START_TAG] }),
    ]);

    expect(judgement.violations).toHaveLength(1);
    expect(judgement.violations[0]).toContain("says both");
    expect(judgement.violations[0]).toContain("both");
  });

  it("stays silent on a run where nothing declared a temperature", () => {
    const judgement = judgeRun([
      start({ title: "unrelated spec" }),
      start({ title: "another one", tags: ["@webkit"] }),
    ]);

    expect(judgement.violations).toEqual([]);
  });
});
