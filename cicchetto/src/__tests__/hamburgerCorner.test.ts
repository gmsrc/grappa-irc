import { describe, expect, it } from "vitest";
import { ruleBody, themeCss } from "./helpers/themeCss";

// #1039 — the mobile ☰ rail opener jumped when you switched window kind: on a
// channel it rides inline in `.topic-bar`, on every other kind it is #985's
// float over `.shell-chrome`, and the two placed it with different offsets
// (`0.5rem`/`1rem` vs `0.25rem`/`0.5rem`). Both anchor to the same box — on a
// channel `.shell-main` → `.drop-upload-zone` (no padding) → `.topic-bar`, on
// every other kind `.shell-main` → `.shell-chrome` — so the disagreement was
// visible as a jump up and to the right.
//
// These are SOURCE-level guards, the same shape and for the same reason as
// `shellChromeFloat.test.ts`: jsdom has no layout engine, so the rendered
// geometry is not observable in any gate that runs locally. The rendered
// outcome — the glyph landing on the same pixel across a kind switch, and
// staying put when the topic wraps to a second line — is pinned in
// `e2e/tests/issue1039-hamburger-corner.spec.ts`.
//
// What this file is FOR is the drift the issue actually asks to prevent: "a
// spec that pins the two offsets to the same value, so the next refactor of
// either container cannot silently drift them apart again". So it deliberately
// does NOT hardcode `0.5rem` / `1rem` anywhere — it asserts that the two
// readers name the SAME custom property and that `:root` defines it. A future
// re-tune of the inset is one edit and stays green; a future re-hardcode of
// either side is red.

/** The balanced `{…}` body starting at `open`, so a scan cannot run past a block's close. */
function balancedBlock(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced block at ${open}`);
}

/** The first two values of a `padding` / `margin` shorthand: block, then inline. */
function insetPair(body: string, prop: "padding" | "margin"): string[] {
  const match = new RegExp(`(?:^|[\\s;])${prop}:\\s*([^;]+);`).exec(body);
  if (match?.[1] === undefined) throw new Error(`no \`${prop}\` shorthand in: ${body.trim()}`);
  // No value here contains a space inside parens (`var(--x)` has none), so a
  // plain whitespace split is the whole parse.
  return match[1].trim().split(/\s+/);
}

const TOPIC_BAR = insetPair(ruleBody(".topic-bar"), "padding");
const FLOAT = insetPair(ruleBody(".shell-chrome .shell-chrome-rail-opener"), "margin");

describe("#1039 both mobile ☰ hosts read one inset", () => {
  it("the two hosts name the SAME custom property on each axis", () => {
    // THE guard. `.topic-bar`'s `padding: <block> <inline>` and the float's
    // `margin: <top> <right> 0 0` agree position-for-position on the two axes
    // that place the glyph, so re-hardcoding either side is red here.
    expect(FLOAT[0]).toBe(TOPIC_BAR[0]); // block / top
    expect(FLOAT[1]).toBe(TOPIC_BAR[1]); // inline / right
  });

  it("that property is a real `:root` token, not a coincidence of two var names", () => {
    // Without this, two rules could agree on `var(--nonexistent)` and the test
    // above would pass while both offsets resolved to nothing.
    const root = ruleBody(":root");
    for (const value of [TOPIC_BAR[0], TOPIC_BAR[1]]) {
      const name = /^var\((--[a-z-]+)\)$/.exec(value ?? "")?.[1];
      expect(name, `${value} is not a bare var() reference`).toBeDefined();
      expect(root).toMatch(new RegExp(`${name}:\\s*[\\d.]+rem;`));
    }
  });

  it("the float still collapses its other two sides", () => {
    // `margin: <top> <right> 0 0`. The bottom is what keeps the float out of
    // the flow it overflows; the left is what keeps `justify-content: flex-end`
    // resolving the right edge against the margin-right above. Read the 4-value
    // shorthand as such, or position 1 is not "right" at all.
    expect(FLOAT).toHaveLength(4);
    expect(FLOAT[2]).toBe("0");
    expect(FLOAT[3]).toBe("0");
  });

  it("the channel ☰ pins to the top of the bar instead of centring in it", () => {
    // `.topic-bar`'s `align-items: center` (#644) centres BOTH children. That
    // is identical to top-pinning while the 48px ☰ is the tallest child, and
    // drifts the moment `.topic-bar-header` outgrows it — a two-line topic
    // (#344/#644) pushes the ☰ down by half the excess, and the float has no
    // such term. Matching only the single-line case would have left the jump.
    const mobileHamburger = /\.topic-bar \.topic-bar-hamburger\s*\{([^}]*align-self[^}]*)\}/.exec(
      themeCss,
    )?.[1];
    expect(
      mobileHamburger,
      "no `.topic-bar .topic-bar-hamburger` rule sets align-self",
    ).toBeDefined();
    expect(mobileHamburger).toMatch(/align-self:\s*flex-start/);
    // Mobile-only: the desktop rule is the `display: none` gate, and pinning
    // there would be dead weight on a hidden button.
    expect(mobileHamburger).toMatch(/display:\s*inline-flex/);
  });

  it("no ≤768px override redeclares the bar's padding behind the token's back", () => {
    // `ruleBody` reads TOP-LEVEL rules only, so a `.topic-bar` rule nested in
    // the mobile media block would win at runtime and be invisible to the
    // assertions above. The one indented `.topic-bar` rule that exists today is
    // the #319 landscape-compact tier, gated `min-width: 769px` — desktop,
    // where the ☰ is `display: none` and this whole contract is moot.
    // Comments stripped first: a brace inside CSS prose would derail the walk.
    // `[ \t]` and not `\s` — `\s` spans newlines, so `^\s+\.topic-bar` also
    // matches the TOP-LEVEL rule one blank line down, and the guard reds out on
    // the very declaration it is meant to protect.
    const stripped = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
    let scanned = 0;
    for (const media of stripped.matchAll(/@media ([^{]*)\{/g)) {
      if (!/max-width:\s*768px/.test(media[1] ?? "")) continue;
      scanned += 1;
      const body = balancedBlock(stripped, (media.index ?? 0) + (media[0]?.length ?? 0) - 1);
      expect(body, "a mobile `.topic-bar` rule can silently retarget the inset").not.toMatch(
        /(^|\n)[ \t]*\.topic-bar[ \t]*\{/,
      );
    }
    // The mobile breakpoint exists — otherwise the loop above is vacuous and
    // this test passes by scanning nothing.
    expect(scanned).toBeGreaterThan(0);
  });
});
