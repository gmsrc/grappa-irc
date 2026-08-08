import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #775 — the marker write is the one half of this feature no test can import.
//
// `main.tsx` is the composition root: nothing imports it, so deleting the
// marker write leaves the entire suite green while the auto-refresh reloads
// silently forever. Every module-level test would keep proving what it proved
// before — `staleResume` still passes `"bundle"`, `bundleRefreshNotice` still
// consumes a marker somebody else wrote, `Toasts` still announces one it finds
// — and none of them observe that production never writes it.
//
// The consume half needs no test like this: it moved into `Toasts`'s mount, so
// `Toasts.test.tsx` covers it by rendering. This is only for what is left.
//
// Source assertion, in the idiom of moduleRootGuard.test.ts / biomePin.test.ts
// / versionSource.test.ts — and like them it carries an anti-vacuity case, so
// renaming the verb cannot make the guard silently stop guarding. Whitespace is
// stripped before matching so a biome reflow cannot break it.

const source = (rel: string): string =>
  readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\s+/g, "");

describe("#775 — the marker write in the composition root", () => {
  // #1063 moved the write itself into `requestBundleRefresh`, so what the root
  // still owns — and still nothing can import — is the ORIGIN it picks per
  // branch. That is now the load-bearing half: get it wrong and #695's
  // age-reload starts announcing itself, or #674's deploy stops.
  it("routes each reload branch to its own origin", () => {
    expect(source("src/main.tsx")).toContain(
      'requestBundleRefresh(Date.now(),bootBundleHashAccessor(),reason==="bundle"?"auto":"silent"',
    );
  });

  it("still guards something — the verb it names is the one the notice exports", () => {
    // Without this, renaming `requestBundleRefresh` on both sides would leave
    // the assertion above passing against a feature that no longer works.
    expect(source("src/lib/bundleRefreshNotice.ts")).toContain(
      "exportasyncfunctionrequestBundleRefresh(now:number,fromHash:string|null,origin:BundleRefreshOrigin",
    );
  });
});
