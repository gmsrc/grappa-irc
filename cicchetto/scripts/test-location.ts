#!/usr/bin/env bun
// #1582 — the `bun run check` stage that keeps cic unit tests in ONE place.
//
// They used to live in three: `src/__tests__/` (272 files), `src/lib/__tests__/`
// (23) and co-located `src/lib/*.test.ts` (14), all three receiving commits in
// the same week, and five modules were tested from two of them at once. The
// cost is not tidiness — it is that ABSENCE stops being evidence. When
// `mobilePanel`'s seven verbs were split four/three across two files, a verb
// missing from the file you opened meant nothing: it might be covered next
// door, or nowhere.
//
// 🔴 A DOC LINE ALREADY FAILED AT THIS JOB, measured: `docs/TESTING.md` has
// named `src/__tests__/` since 2026-05-24, and `src/lib/__tests__/` was created
// the SAME DAY. The line was never false — tests really do live in the named
// directory — which is also why the #1554 audit of that file, checking 21
// claims for falsehood, did not catch it. An incomplete claim survives a
// falsehood check. So the convention gets a gate, not a second sentence.
//
// Exit codes follow `lock-drift.ts`:
//   0  every test file is where the convention says
//   1  at least one is not
//   3  a known-answer control failed — NO verdict is printed, because a
//      classifier that cannot answer a question with a known answer cannot be
//      believed when it answers one without.
import { readdirSync } from "node:fs";
import { join } from "node:path";

// The convention, as one predicate. `src/__tests__/helpers/` holds shared
// fixtures rather than cases, so it is inside the home directory and needs no
// exception of its own.
const HOME = "src/__tests__/";

export const isTestFile = (path: string): boolean => /\.(test|spec)\.tsx?$/.test(path);

export const isMisplaced = (path: string): boolean => isTestFile(path) && !path.startsWith(HOME);

// Known answers. Each control names a way the predicate could be wrong: a
// production module mistaken for a test, a test in the home directory called a
// violation, a test in either of the two locations this issue emptied called
// fine, a shared helper (no `.test.`) called a test, and `.spec.` — which
// `vitest.config.ts` includes for `src/**` — not being recognised at all.
const CONTROLS: ReadonlyArray<readonly [string, boolean]> = [
  ["src/lib/customTheme.ts", false],
  ["src/__tests__/customTheme.test.ts", false],
  ["src/__tests__/helpers/themeCss.ts", false],
  ["src/__tests__/Shell.test.tsx", false],
  ["src/__tests__/foo.spec.ts", false],
  ["src/lib/__tests__/customTheme.test.ts", true],
  ["src/lib/channelTopic.test.ts", true],
  ["src/lib/deep/nested/thing.test.tsx", true],
  ["src/Shell.spec.tsx", true],
];

function selfTest(): string[] {
  const failures: string[] = [];
  for (const [path, expected] of CONTROLS) {
    const got = isMisplaced(path);
    if (got !== expected) failures.push(`${path}: expected misplaced=${expected}, got ${got}`);
  }
  return failures;
}

function walk(dir: string, prefix: string): string[] {
  const out: string[] = [];
  let entries: ReturnType<typeof readdirSync<{ withFileTypes: true }>>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

const failures = selfTest();
if (failures.length > 0) {
  console.error("test-location: SELF-TEST FAILED — refusing to report a verdict");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(3);
}

const all = walk(join(process.cwd(), "src"), "src");
const tests = all.filter(isTestFile);
const misplaced = tests.filter(isMisplaced);

// The count is the honesty payload, same argument as `check.ts`'s stage
// summary: "0 misplaced" says nothing unless you also know how many were
// looked at. A walk that silently found no files would otherwise read green.
console.log(`test-location: ${tests.length} test files under src/, ${misplaced.length} misplaced`);

if (tests.length === 0) {
  console.error("test-location: found NO test files under src/ — the walk cannot be believed");
  process.exit(3);
}

if (misplaced.length > 0) {
  for (const path of misplaced) console.error(`  MISPLACED ${path}`);
  console.error(
    `test-location: cic unit tests live in ${HOME} and nowhere else (#1582). Move the ` +
      "file there and rewrite its relative imports; if the module it covers already has a " +
      "test file in that directory, MERGE into it rather than landing a second one.",
  );
  process.exit(1);
}
