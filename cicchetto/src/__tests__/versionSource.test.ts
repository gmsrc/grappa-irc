import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #538 — package.json's `version` is neutralised to 0.0.0. The reported cic
// version now comes from mix.exs @version via the GRAPPA_VERSION env, which
// vite bakes into <meta name="cicchetto-version"> (see vite.config.ts) — NOT
// from here. This guards the inert placeholder so nobody re-hardcodes a
// competing semver, which is exactly the 0.0.1-vs-0.6.x drift #538 fixes.
//
// Client twin of the server-side carrier guard,
// test/grappa/version_single_source_test.exs (which cannot read package.json —
// the worktree overlay mounts only cicchetto/src into the Elixir test
// container). vitest runs from the cicchetto dir, so package.json is at cwd.
describe("cic package.json version (#538 single version source)", () => {
  it("is the inert 0.0.0 placeholder, not a hand-maintained semver", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };

    expect(pkg.version).toBe("0.0.0");
  });
});
