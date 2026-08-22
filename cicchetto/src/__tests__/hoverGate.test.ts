import { describe, expect, it } from "vitest";
import { hoverGatedBlocks, themeCss } from "./helpers/themeCss";

// #1658 second defect — a scroll must not light up the row under the finger.
//
// A touch browser SYNTHESIZES `:hover` on the element the finger lands on and
// LATCHES it: put a finger down to scroll the channel directory — or to pull it
// for a refresh, which is the whole of #1658's first defect — and the row under
// it paints, and STAYS painted after the finger leaves. This sheet already
// knows the cure and carries it at three other sites; `.directory-row-join` was
// left out.
//
// WHY A SOURCE-LEVEL TEST AND NOT A BEHAVIOURAL ONE. The behaviour needs a
// browser that reports `(hover: none)`, and Playwright cannot emulate that:
// `page.emulateMedia()` covers `media`, `colorScheme`, `reducedMotion`,
// `forcedColors` and `contrast` — there is no `hover` key, so no project in
// this repo can put the media query into its false branch on purpose. Nor does
// jsdom apply a stylesheet. What IS deterministic is what the cascade is ASKED
// to do, and that is what these read. They say nothing about what any engine
// paints; vjt's phone is the only witness for that half.
const SELECTOR = ".directory-row-join:hover";

// Comments stripped for the same reason `themeCss`'s helpers strip them: the
// gate's own why-comment names the selector, and prose must not be able to
// stand in for a rule.
const stripped = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("#1658 — the directory row's hover fill is gated on hover-capable input", () => {
  // The CONTROL, and it runs first because the assertion below passes just as
  // well against a sheet that deleted the rule outright. Gating an affordance
  // and removing it are different changes and only one of them was asked for.
  it("still declares the fill it always declared", () => {
    expect(occurrences(stripped, SELECTOR), `${SELECTOR} rules in default.css`).toBe(1);
    expect(stripped).toMatch(/\.directory-row-join:hover\s*\{[^}]*background:\s*var\(--border\)/);
  });

  // The discriminator. Counted rather than "at least one is gated": a second,
  // ungated copy added later would satisfy an existence check while restoring
  // the exact defect. Every declaration of it must be behind the query, or none
  // of them is.
  it("declares it ONLY inside a (hover: hover) gate", () => {
    const total = occurrences(stripped, SELECTOR);
    const gated = occurrences(hoverGatedBlocks().join("\n"), SELECTOR);

    expect(gated, `${SELECTOR} declarations inside @media (hover: hover)`).toBe(total);
  });
});
