// #1584 — the driver half of the cold-start cure. Everything that is a
// DECISION lives in `coldStartLedger.ts` and is proven by vitest; this file
// only turns Playwright's reporter callbacks into that decision's input, and
// its answer into stdout plus a run status.
//
// Registered in `playwright.config.ts`, so it runs on EVERY invocation —
// full suite, `--grep`, single file, iso-rerun. That is the point: the
// invocations that silently change the input are exactly the scoped ones.

import { basename } from "node:path";
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { type CensusRow, judgeRun, type TestStart } from "./coldStartLedger";

class ColdStartReporter implements Reporter {
  private readonly starts: TestStart[] = [];

  onTestBegin(test: TestCase, result: TestResult): void {
    this.starts.push({
      // `parent` is the innermost suite; `project()` walks up to the project
      // suite, and is undefined only for the root.
      project: test.parent.project()?.name ?? "<no project>",
      workerIndex: result.workerIndex,
      title: `${basename(test.location.file)} > ${test.title}`,
      tags: test.tags,
    });
  }

  // `async` is load-bearing, not decoration: Reporter.onEnd's synchronous
  // branch is typed `void`, so only the Promise branch may carry a status
  // override back to Playwright.
  async onEnd(_result: FullResult): Promise<{ status: FullResult["status"] } | undefined> {
    const { census, violations } = judgeRun(this.starts);
    process.stdout.write(renderCensus(census));

    if (violations.length === 0) return undefined;

    process.stdout.write(
      `\n#1584 cold-start violations — ${violations.length} declared start ` +
        `temperature(s) did not match this run:\n` +
        violations.map((violation) => `  - ${violation}\n`).join("") +
        "\n  The run is failed on this alone. Nothing above is a product " +
        "verdict:\n  a result measured on the wrong side of this input is not a " +
        "result.\n",
    );
    return { status: "failed" };
  }
}

// Printed on EVERY run, green included. A census only a red run prints is a
// census the reader never sees on the runs where the misreading happens.
function renderCensus(census: readonly CensusRow[]): string {
  const header =
    "\n#1584 cold-start census — the first test each Playwright worker began.\n" +
    "  That test paid the browser launch; every later test in the same worker\n" +
    "  ran against an already-running browser. Position is an input to every\n" +
    "  spec in this suite, and these are its values for this run.\n";

  if (census.length === 0) return `${header}  (no test reached a worker)\n`;

  return (
    header +
    census
      .map(
        (row) =>
          `  ${row.project} / worker ${row.workerIndex}: ${row.title} [${row.declaration}]\n`,
      )
      .join("")
  );
}

export default ColdStartReporter;
