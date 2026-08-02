import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #515 — @biomejs/biome MUST be pinned to an EXACT version (no `^`/`~`/range
// operator). A formatter on a floating range is a time bomb: a newer 2.x minor
// resolved in the container ships a stricter formatter that flips `bun run
// check` RED on clean main with no code change of ours (the #508
// `input:where(:not(...))` denylist selector in default.css got flagged as a
// formatter error). Exact-pinning makes every biome change a DELIBERATE,
// reviewed diff in its own commit — never a silent between-session red.
//
// This guard fails fast in a unit test the moment someone re-carets the pin,
// instead of surfacing as a slow, mysterious check.sh red in a later session.
// Sibling of versionSource.test.ts; vitest runs from the cicchetto dir, so
// package.json is at cwd.
describe("cic biome pin (#515 exact-pin the formatter)", () => {
  it("pins @biomejs/biome to an exact version, not a floating range", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };

    const pin = pkg.devDependencies["@biomejs/biome"];
    expect(pin, "@biomejs/biome missing from devDependencies").toBeDefined();
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
