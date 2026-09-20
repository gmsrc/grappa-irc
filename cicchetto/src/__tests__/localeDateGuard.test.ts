import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// issue 2270, shape point 3 — "all five sites call that renderer, none call
// `toLocale*` directly — enforceable with a lint rule so the next one cannot
// regress."
//
// This is that rule. It lives in vitest rather than in biome because the repo
// already enforces its source-shape invariants here (`moduleRootGuard`,
// `biomePin`, `versionSource`), because biome's own rule set has nothing that
// expresses "this method, on this receiver, outside this module", and because a
// test can pin the PREDICATE with fixtures — a guard that has only ever run
// over a clean tree proves nothing about what it would catch.
//
// The invariant: a date's rendered notation is decided in ONE module. Five
// sites each calling `toLocaleString()` is how the same bug got written five
// times, and it is how a sixth would.

// The one door. It renders through `Intl.DateTimeFormat` with an explicitly
// resolved locale, never through an implicit `toLocale*` default.
const RENDERER = "src/lib/dateFormat.ts";

// A NUMBER is a different axis, and the issue left it out of scope on purpose
// ("thousands separators … left alone unless the same decision is extended to
// numbers"). The exemption is by file, so it is paired with a second assertion
// below proving that file formats no DATE — otherwise the exemption would
// quietly widen the day someone put a timestamp in it.
const NUMBER_AXIS_EXEMPT = "src/LusersCard.tsx";

const isTestFile = (rel: string): boolean =>
  rel.includes("__tests__") || /\.test\.tsx?$/.test(rel) || rel === "src/setupTests.ts";

// Prose carries the history: several comments quote the very calls this guard
// forbids, including `toLocaleUpperCase` in `radioLogoPlaceholder.ts` and
// `toLocaleDateString` in `buildCredits.ts`.
const isProse = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
};

// `toLocaleDateString` / `toLocaleTimeString` are date renderers whatever the
// receiver. `toLocaleString` is the ambiguous one — `Date` and `Number` both
// have it — and it is caught too, with the number axis exempted by file above.
// `toLocaleUpperCase` / `toLocaleLowerCase` are NOT matched: they are a casing
// axis with its own documented posture (`radioLogoPlaceholder.ts`).
const LOCALE_CALL = /\.toLocale(?:Date|Time)?String\s*\(/;

/** Every offending line number in one module's source. Pure over text. */
function localeCallLines(src: string): number[] {
  const found: number[] = [];
  src.split("\n").forEach((line, i) => {
    if (isProse(line)) return;
    if (LOCALE_CALL.test(line)) found.push(i + 1);
  });
  return found;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("locale date guard (issue 2270 — the predicate)", () => {
  it("flags each of the three spellings", () => {
    expect(localeCallLines("  return new Date(x).toLocaleString();")).toEqual([1]);
    expect(localeCallLines("  return d.toLocaleDateString(undefined, opts);")).toEqual([1]);
    expect(localeCallLines("  return d.toLocaleTimeString();")).toEqual([1]);
  });

  it("ignores prose — the tree explains this bug in comments that quote it", () => {
    expect(localeCallLines("// never call .toLocaleString() from a render path")).toEqual([]);
    expect(localeCallLines(" * `toLocaleDateString` would make the roll say something")).toEqual(
      [],
    );
  });

  it("leaves the casing axis alone — it is a different rule with its own posture", () => {
    expect(localeCallLines("  return s.toLocaleUpperCase();")).toEqual([]);
    expect(localeCallLines("  return s.toLocaleLowerCase();")).toEqual([]);
  });

  it("reports every offending line, not just the first", () => {
    expect(localeCallLines("a.toLocaleString();\nconst x = 1;\nb.toLocaleDateString();")).toEqual([
      1, 3,
    ]);
  });
});

describe("locale date guard (issue 2270 — one renderer, and it stays one)", () => {
  it("no module renders a date through an implicit locale default", () => {
    const root = resolve(process.cwd(), "src");
    const found: string[] = [];

    for (const file of sourceFiles(root)) {
      const rel = relative(process.cwd(), file);
      if (isTestFile(rel) || rel === NUMBER_AXIS_EXEMPT) continue;
      for (const line of localeCallLines(readFileSync(file, "utf8"))) {
        found.push(`${rel}:${line}`);
      }
    }

    expect(
      found,
      `render dates through lib/dateFormat.ts — a bare toLocale* inherits the\n` +
        `browser UI LANGUAGE as its notation, which is issue 2270:\n${found.join("\n")}`,
    ).toEqual([]);
  });

  it("the number-axis exemption covers no date — otherwise it is a hole", () => {
    // The exemption is granted to a file, so what keeps it honest is that the
    // file has no Date in it at all. The moment one appears, this fails and the
    // exemption has to be re-argued rather than silently inherited.
    const src = readFileSync(resolve(process.cwd(), NUMBER_AXIS_EXEMPT), "utf8");
    expect(src).not.toMatch(/\bDate\b/);
  });

  it("still guards something — the renderer exists and resolves a locale itself", () => {
    // Without this, deleting `dateFormat.ts` (or gutting it back to a bare
    // `toLocale*`) would leave the sweep above vacuously green.
    const src = readFileSync(resolve(process.cwd(), RENDERER), "utf8");
    expect(src).toMatch(/Intl\.DateTimeFormat/);
    expect(src).toMatch(/export function resolveLocale/);
    expect(localeCallLines(src)).toEqual([]);
  });
});
