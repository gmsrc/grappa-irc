import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #717 — a bare `createRoot` must not come back.
//
// The first cut of #717 gave the error context to `identityScopedStore` alone
// and left every other module root bare. `activeWindows.ts` — a module-level
// memo reading `channelsBySlug()` and `networks()`, subscribed before the first
// render — then went on swallowing the `listNetworks`/`listChannels` failures
// exactly as before: it runs EARLIER in the Updates queue than the store's own
// memo, throws with no error context, and `runUpdates` discards the queued
// render effects before the store's handler is ever reached. The splash froze
// through the gap between the two patterns.
//
// CLAUDE.md: "Half-migrated creates two patterns — Claude copies whichever is
// closer." So the migration is total and this test is what keeps it total. A
// new root goes through `moduleRoot`; nothing else may call `createRoot`.
//
// Sibling of biomePin.test.ts / versionSource.test.ts — vitest runs from the
// cicchetto dir, so `src` is at cwd.

// The two factories are the door itself: `moduleRoot` opens the root, and
// `identityScopedStore` opens one with the reset wiring deliberately OUTSIDE
// the error context (see its header — a swallowed reset is #281's bug).
const FACTORIES = ["src/lib/moduleRoot.ts", "src/lib/identityScopedStore.ts"];

// Test files are out of scope, and not as a convenience exclusion: the rule is
// about module-LIFETIME roots — singletons that are never disposed, whose throw
// therefore has nowhere to go. A test root is the opposite, and says so in its
// own shape: every one of them takes the `dispose` callback and scopes ownership
// to the case. `createRoot` is exactly the right primitive there.
const isTestFile = (rel: string): boolean =>
  rel.includes("__tests__") || /\.test\.tsx?$/.test(rel) || rel === "src/setupTests.ts";

// Matches a call, not the word: comments and prose about `createRoot` are fine
// and there are several that explain the history.
const BARE_ROOT = /\bcreateRoot\s*\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("module roots (#717 — one door, and it stays one)", () => {
  it("has no bare createRoot outside the root factories", () => {
    const root = resolve(process.cwd(), "src");
    const offenders: string[] = [];

    for (const file of sourceFiles(root)) {
      const rel = relative(process.cwd(), file);
      if (FACTORIES.includes(rel) || isTestFile(rel)) continue;
      const src = readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        // Skip comment lines — the migration left explanatory prose behind.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (BARE_ROOT.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }

    expect(
      offenders,
      `bare createRoot found — use moduleRoot() so the root gets an error context (#717):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("still guards something — the factories themselves do call createRoot", () => {
    // Without this, deleting both factories (or renaming the call) would leave
    // the test above vacuously green.
    const called = FACTORIES.filter((f) =>
      BARE_ROOT.test(readFileSync(resolve(process.cwd(), f), "utf8")),
    );
    expect(called).toEqual(FACTORIES);
  });
});
