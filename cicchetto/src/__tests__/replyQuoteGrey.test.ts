import { describe, expect, it } from "vitest";
import { ruleBody } from "./helpers/themeCss";

// issue 2112 — the quoted head of a reply takes the grey the PRESENCE rows read
// as ON SCREEN, not the `--muted` it shared with timestamps until now.
//
// WHAT THIS PROVES — source-level invariants over `src/themes/default.css`:
//   * the quote's colour is DERIVED from `--fg`/`--bg`, so the gallery themes
//     and the theme editor need no per-theme work and no new token is owed;
//   * the damping it mixes with is the SAME fraction the presence row's
//     `opacity` applies. That number lives in two rules and they have to move
//     together — this is what makes the drift loud instead of silent;
//   * the premise the target rests on: the presence row's body text is
//     `--fg`-based, which is the counter-intuitive half of issue 2112 and the
//     reason reading the stylesheet alone gets the answer wrong.
//
// WHAT THIS DOES NOT PROVE — and no jsdom test can:
//   * that the two regions PAINT the same grey. jsdom resolves neither `var()`
//     nor `color-mix()` and has no compositor. The painted equality is measured
//     in a real browser by `e2e/tests/issue2112-reply-quote-presence-grey.spec.ts`.
//   * that `color-mix` is supported by the engine. An engine without it drops
//     the declaration at computed-value time and the head inherits
//     `.scrollback-body`'s `--fg` — undimmed and fully readable.
//   * anything about WHICH characters are dimmed. That boundary is the
//     renderer's, proven in `MircText.test.tsx` (issue 2086).

describe("issue 2112 — the reply-quote grey is the presence rows' grey", () => {
  const quote = ruleBody(".scrollback-reply-quote");
  const presenceRow = ruleBody(".scrollback-line.scrollback-muted");
  const body = ruleBody(".scrollback-body");

  const declaration = (rule: string, property: string): string => {
    const match = rule.match(new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`));
    const value = match?.[1];
    if (value === undefined) throw new Error(`no \`${property}\` declared in: ${rule.trim()}`);
    return value.trim();
  };

  it("derives the quote colour from --fg/--bg, with no literal and no new token", () => {
    const colour = declaration(quote, "color");

    expect(colour, "the quote colour must be relative to the theme's own --fg").toContain(
      "var(--fg)",
    );
    expect(colour, "…and damped toward the theme's own --bg").toContain("var(--bg)");
    // A literal grey is what would break the gallery themes and the editor —
    // the constraint issue 2086 accepted and issue 2112 keeps.
    expect(colour, "a literal colour here does not follow a custom theme").not.toMatch(
      /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i,
    );
    // The issue is explicit that no new token is needed; declaring one here
    // would put per-theme work back on the gallery.
    expect(quote.match(/(^|;)\s*--[\w-]+\s*:/), "no new custom property is owed").toBeNull();
  });

  it("damps by the SAME fraction the presence row's opacity applies", () => {
    // The two numbers are the whole point of the issue: the grey being matched
    // IS `--fg` seen through the presence row's damping. They live in separate
    // rules, so nothing but this test keeps them in step.
    const opacity = Number.parseFloat(declaration(presenceRow, "opacity"));
    expect(
      opacity,
      "`.scrollback-line.scrollback-muted` still damps the presence row",
    ).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);

    const colour = declaration(quote, "color");
    const mix = colour.match(/color-mix\(\s*in\s+srgb\s*,\s*var\(--fg\)\s+([\d.]+)%\s*,/);
    const percent = mix?.[1];
    if (percent === undefined) {
      throw new Error(`quote colour is not an srgb mix of --fg toward --bg: ${colour}`);
    }

    // sRGB and not oklab: the grey being matched is produced by an `opacity`
    // composite, which the compositor performs in the device space. An oklab
    // mix at the same percentage lands somewhere else entirely.
    expect(
      Number.parseFloat(percent) / 100,
      `the quote keeps ${percent}% of --fg while the presence row damps to ${opacity} — ` +
        "the two greys have drifted apart",
    ).toBeCloseTo(opacity, 5);
  });

  it("pins the premise: the presence row's body text is --fg-based, not --muted", () => {
    // `.scrollback-presence` declares `color: var(--muted)` and never reaches
    // the text: `.scrollback-body` is a DESCENDANT and declares its own colour,
    // which beats what it inherits. That is why the join text is `--fg` damped
    // by the row opacity — the BRIGHTEST of the three greys on screen — and why
    // reading the stylesheet for "they are all --muted" gets it wrong.
    expect(
      declaration(body, "color"),
      "if the body stops forcing --fg, the presence grey moves and the quote no longer matches it",
    ).toBe("var(--fg)");
  });
});
