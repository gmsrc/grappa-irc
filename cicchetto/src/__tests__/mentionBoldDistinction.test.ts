import { describe, expect, it } from "vitest";
import { allRules, ruleBody, themeCss } from "./helpers/themeCss";

// issue 2167 — the mention row's bold goes behind a preference, and the
// preference must not be able to collapse the mention state into the
// watchlist-highlight state.
//
// WHY THIS GATE EXISTS. The bold on `.scrollback-line.scrollback-mention`
// CARRIES WEIGHT: the sibling state `.scrollback-line.scrollback-highlight`
// (watchlist match) is deliberately NOT bold, and the comment above it says so
// in as many words — "softer background, no bold, so the two states are clearly
// different". So the bold is one of the axes that tell the two apart, and
// issue 2167 takes it away on request. The question this file answers is the
// one vjt's ruling attached to the slice: with the preference ON (bold off),
// are a mention row and a highlight row still distinguishable?
//
// They are, and on TWO surviving axes rather than the one the issue names:
//   * the BACKGROUNDS differ — the mention takes the flat `--mention` token,
//     the highlight a 12% `--accent` mix. The issue only claims the mention
//     "keeps its `--mention` background, which the highlight row does not
//     have"; measured, the highlight has a background of its own, so the axis
//     is a DIFFERENCE and not a presence/absence.
//   * the highlight paints a 2px `--accent` bar in the gutter via `::before`
//     (#1298). The mention has no such pseudo-element.
//
// WHAT THIS PROVES — source-level invariants over `src/themes/default.css`:
//   * the bold is reachable by the preference at all (else the feature is not
//     wired), and its FALLBACK is `bold`, so a browser that has not run the
//     boot write — and a server that never heard of the key — still renders
//     today's appearance;
//   * the preference's custom property reaches EXACTLY ONE declaration in the
//     whole stylesheet. This is the assertion that makes the collapse
//     impossible rather than merely unlikely: if a later edit routes the
//     mention's `background` (or the highlight's) through the same property,
//     turning the preference on would erase a distinguishing axis, and this
//     test goes red;
//   * both distinguishing axes are still declared, and they are DIFFERENT.
//
// WHAT THIS DOES NOT PROVE — and no jsdom test can:
//   * that the two rows PAINT differently. jsdom resolves neither `var()` nor
//     `color-mix()` and has no compositor, so "these two CSS values are not
//     the same string" is the strongest claim available here. A theme is free
//     to set `--mention` to the same colour its `--accent` mix lands on; that
//     is a theme bug, not a regression this gate can see.
//   * anything about WHICH rows get which class. That boundary belongs to
//     `mentionMatch.test.ts` and `ScrollbackPane.test.tsx`.

const PREF_VAR = "--mention-font-weight";

describe("issue 2167 — the mention/highlight distinction survives bold-off", () => {
  const mention = ruleBody(".scrollback-line.scrollback-mention");
  const highlight = ruleBody(".scrollback-line.scrollback-highlight");

  const declaration = (rule: string, property: string): string => {
    const match = rule.match(new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`));
    const value = match?.[1];
    if (value === undefined) throw new Error(`no \`${property}\` declared in: ${rule.trim()}`);
    return value.trim();
  };

  it("routes the mention's bold through the preference, defaulting to bold", () => {
    const weight = declaration(mention, "font-weight");

    // Reachable by the preference — without this the toggle is inert.
    expect(weight, "the mention's weight must be driven by the preference").toContain(
      `var(${PREF_VAR}`,
    );
    // …and the FALLBACK is today's appearance. This is what keeps the first
    // paint (and a server predating the key) rendering bold rather than
    // silently shipping the opt-out to everyone.
    expect(weight, "an unset preference must still render bold").toMatch(
      new RegExp(`var\\(\\s*${PREF_VAR}\\s*,\\s*bold\\s*\\)`),
    );
  });

  // THE COLLAPSE GUARD. Everything else in this file describes the two states;
  // this is the assertion that fails if a later edit lets the preference reach
  // an axis that distinguishes them.
  it("lets the preference reach EXACTLY ONE declaration in the whole sheet", () => {
    const consumers = allRules().flatMap((rule) =>
      rule.body.includes(`var(${PREF_VAR}`) ? [rule.selectors] : [],
    );

    expect(
      consumers,
      "the bold preference must drive the mention's weight and nothing else — " +
        "a second consumer is how the mention and highlight states collapse",
    ).toEqual([".scrollback-line.scrollback-mention"]);

    // And it is declared nowhere as a fallback-carrying token either: a
    // `:root` default would make the `var(…, bold)` fallback above dead code,
    // and the next reader would trust the wrong default.
    expect(
      themeCss.includes(`${PREF_VAR}:`),
      `${PREF_VAR} must live only on the element, written by the preference — ` +
        "declaring it in the sheet shadows the fallback this gate just pinned",
    ).toBe(false);
  });

  it("keeps the two backgrounds declared and DIFFERENT", () => {
    const mentionBg = declaration(mention, "background");
    const highlightBg = declaration(highlight, "background");

    expect(mentionBg, "the mention row keeps its own background").not.toBe("");
    expect(highlightBg, "the highlight row keeps its own background").not.toBe("");
    expect(mentionBg, "identical backgrounds would leave bold-off rows indistinguishable").not.toBe(
      highlightBg,
    );

    // Neither background is behind the preference — belt to the collapse
    // guard's braces, stated per-rule so a failure names which one moved.
    expect(mentionBg, "the mention background must not depend on the bold pref").not.toContain(
      PREF_VAR,
    );
    expect(highlightBg, "the highlight background must not depend on the bold pref").not.toContain(
      PREF_VAR,
    );
  });

  it("keeps the highlight's accent bar, the axis the mention never had", () => {
    // #1298's painted bar. `ruleBody` throws when the rule is absent, so this
    // is an existence assertion as much as a content one.
    const bar = ruleBody(".scrollback-line.scrollback-highlight::before");

    expect(declaration(bar, "background"), "the bar is the accent colour").toContain(
      "var(--accent)",
    );
    expect(declaration(bar, "width"), "…and it is the 2px gutter bar").toBe("2px");

    // The mention has no such pseudo-element — the asymmetry IS the axis.
    const mentionPseudo = allRules().filter((rule) =>
      rule.selectors.includes(".scrollback-mention::before"),
    );
    expect(mentionPseudo, "a mention ::before would blur the axis the highlight relies on").toEqual(
      [],
    );
  });
});
