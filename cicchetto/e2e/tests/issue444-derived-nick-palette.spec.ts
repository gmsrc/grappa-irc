// #444 — nick palette widened from 16 to 32 render buckets. The theme
// still AUTHORS only 16 hues (`--nick-color-0..15`); cic DERIVES buckets
// 16..31 in CSS from those 16 via `color-mix(in oklab, var(--nick-color-k),
// var(--fg) 38%)` (a tone shift toward the foreground), so the render
// palette doubles with zero server / theme-token / migration change.
//
// Why this e2e exists (and why the unit test is NOT enough): jsdom is
// CSS-cascade-blind and does NOT compute `color-mix` (per
// `feedback_cicchetto_browser_smoke`). The unit test in
// `src/__tests__/nickColor.test.ts` can only assert that a
// `--nick-color-N` DECLARATION exists in `default.css` — it cannot prove
// the declaration RESOLVES to a real colour at render time. That gap is
// exactly the failure mode #444 must not ship: `NickText` renders
// `color: var(--nick-color-N)` with NO fallback, so a bucket that fails to
// resolve is invalid-at-computed-value-time and the nick silently inherits
// `--fg` (uncoloured). Only a real browser exercises the `var()` +
// `color-mix` resolution. This spec pins it.
//
// vjt constraint verified here: the derivation must hold on BOTH shipped
// themes (irssi-dark — light `--fg` on a dark `--bg`; mirc-light — black
// `--fg` on white). A band that fails to resolve, or collapses onto the
// authored band, on either theme is a regression. Colour AESTHETICS (the
// 38% figure, the exact hues) are vjt's to eyeball post-deploy and are NOT
// asserted here — only that every bucket resolves to a distinct, real
// colour on both themes.
//
// The probe injects NickText-shaped nodes at the document level and reads
// their computed colour — the same technique the sibling
// `ux-5-bc2-nick-render.spec.ts` uses for the distinct-nick assertion.
// Driving real IRC traffic is unnecessary: the CSS cascade under test is
// identical, and a document probe keeps the assertion deterministic.

import type { Page } from "@playwright/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { expect, specUser, test } from "../fixtures/test";

// The two shipped base themes. The #444 derived `:root` rule references
// `var(--nick-color-k)`, so switching `data-theme` re-resolves 16..31
// against that theme's authored palette — this is how "holds on BOTH
// themes" is exercised.
const THEMES = ["irssi-dark", "mirc-light"] as const;

test.setTimeout(60_000);

// Resolve the computed `color` for every requested `var(--nick-color-N)`
// under a given theme, plus a deliberately-UNDEFINED bucket as the
// fallback baseline. Runs entirely in-page so the live cascade (the base
// `:root[data-theme]` block + the #444 `:root` derived rule) applies.
//
// Returns serialized computed-colour strings. Chromium may serialize a
// `color-mix(in oklab, ...)` result as `rgb(...)`, `oklab(...)` or
// `color(srgb ...)` depending on version, so callers compare STRINGS for
// (in)equality and never parse channels — the format is irrelevant, only
// "resolved and distinct" matters.
async function resolvePalette(
  page: Page,
  theme: string,
  indices: number[],
): Promise<{ resolved: Record<number, string>; undefinedFallback: string; fg: string }> {
  return page.evaluate(
    ({ theme, indices }) => {
      const root = document.documentElement;
      const prevTheme = root.dataset.theme;
      root.dataset.theme = theme;

      const probe = (colorExpr: string): string => {
        // Mirror NickText's shape: an inline `color: var(...)` on a
        // `.nick-text` span under `.nick`. The live cascade resolves it.
        const outer = document.createElement("span");
        outer.className = "nick";
        const text = document.createElement("span");
        text.className = "nick-text";
        text.style.color = colorExpr;
        text.textContent = "probe";
        outer.appendChild(text);
        document.body.appendChild(outer);
        const resolved = getComputedStyle(text).color;
        document.body.removeChild(outer);
        return resolved;
      };

      const resolved: Record<number, string> = {};
      for (const i of indices) resolved[i] = probe(`var(--nick-color-${i})`);

      // A bucket that is NOT declared anywhere: its `var()` has no
      // fallback, so the property is invalid-at-computed-value-time and
      // `color` (inherited) resolves to the ambient foreground. This is
      // the exact "uncoloured nick" degradation the derivation must avoid,
      // and the baseline every real bucket must differ from.
      const undefinedFallback = probe("var(--nick-color-9999)");
      const fg = probe("var(--fg)");

      root.dataset.theme = prevTheme ?? "";
      return { resolved, undefinedFallback, fg };
    },
    { theme, indices },
  );
}

const DERIVED = Array.from({ length: 16 }, (_, k) => 16 + k); // 16..31
const AUTHORED = Array.from({ length: 16 }, (_, k) => k); // 0..15

test("issue444 — derived buckets 16..31 RESOLVE to a real colour on both themes (no undefined-var fallback)", async ({
  page,
}) => {
  await loginAs(page, specUser());

  for (const theme of THEMES) {
    const { resolved, undefinedFallback, fg } = await resolvePalette(page, theme, DERIVED);

    // Sanity: the undefined-bucket baseline collapses to the ambient
    // foreground — proving the probe correctly detects the "silently
    // inherits --fg" degradation this feature exists to prevent.
    expect(undefinedFallback, `[${theme}] undefined bucket should fall back to --fg`).toBe(fg);

    for (const i of DERIVED) {
      const color = resolved[i];
      // Resolved to *something* (a browser that dropped the declaration
      // would return the inherited value → equal to the undefined
      // baseline).
      expect(color, `[${theme}] --nick-color-${i} must resolve to a colour`).toBeTruthy();
      // The load-bearing assertion: the derived bucket did NOT fall
      // through to the inherited foreground. If color-mix failed to
      // resolve (unsupported / typo / missing declaration), this bucket
      // would equal `undefinedFallback` and every nick hashing here would
      // render uncoloured. This is the real-browser guard jsdom can't give.
      expect(
        color,
        `[${theme}] --nick-color-${i} must NOT collapse to the uncoloured --fg fallback`,
      ).not.toBe(undefinedFallback);
    }
  }
});

test("issue444 — each derived bucket differs from the authored bucket it is a tone-shift of (both themes)", async ({
  page,
}) => {
  await loginAs(page, specUser());

  for (const theme of THEMES) {
    const { resolved: derived } = await resolvePalette(page, theme, DERIVED);
    const { resolved: authored } = await resolvePalette(page, theme, AUTHORED);

    for (let k = 0; k < 16; k++) {
      // `--nick-color-${16 + k}` is derived from `--nick-color-${k}` via a
      // tone shift toward --fg. If the shift were a no-op (0% mix, or a
      // mis-authored rule referencing the wrong base), the two would be
      // identical and the palette would still effectively have 16 hues.
      // They MUST differ — that difference is the whole point of widening.
      expect(
        derived[16 + k],
        `[${theme}] --nick-color-${16 + k} must be a distinct tone from its base --nick-color-${k}`,
      ).not.toBe(authored[k]);
    }
  }
});
