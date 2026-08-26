import { describe, expect, it } from "vitest";
import { themeCss } from "./helpers/themeCss";

// #1766 — the ☰ is drawn in CSS instead of being a character.
//
// vjt asked for a 40px box; refused with the measure and he confirmed
// ("si confermo"). `--chrome-tap-min` is declared on `:root` in ABSOLUTE px on
// purpose — the root font-size is 14px, so in `rem` the target lands under the
// HIG floor, which is #305's "defect 2" and 40px reopens it. What was actually
// wrong is not the box: U+2630 is three THIN strokes centred on the em box, so
// the CHARACTER is thin while the box is not narrow, and next to `⚙`/`@` it
// reads small. vjt: "va bene css" — three bars, no SVG, no codepoint swap, no
// icon set.
//
// The refusal that shapes these tests: NOT a bump of `--chrome-icon-size`.
// That token is #305's "desired parity" — raising it grows the cog, mentions,
// archive, the members ☰ and the presence toggle together, which is not what
// was asked. So the drawing is per-selector on the hamburgers, and the token
// keeps sizing them so a text-size change still moves the glyph.
//
// Source-level guards, the same shape and for the same reason as
// `hamburgerCorner.test.ts` / `shellChromeFloat.test.ts`: jsdom has no layout
// engine and no cascade resolution across the whole sheet, so the rendered
// outcome is not observable in any locally-runnable gate. What IS observable
// here is the trap.

/** Innermost rules, comments stripped, in SOURCE ORDER with their offsets. */
function rulesInOrder(): { selectors: string; body: string; index: number }[] {
  const stripped = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selectors: string; body: string; index: number }[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({
      selectors: (match[1] ?? "").trim(),
      body: match[2] ?? "",
      index: match.index ?? 0,
    });
  }
  return out;
}

const RULES = rulesInOrder();

/** Every rule whose selector list mentions `needle`. */
const mentioning = (needle: string) => RULES.filter((r) => r.selectors.includes(needle));

const barRules = () =>
  RULES.filter((r) => /topic-bar-(hamburger|windows-opener)[^,{]*::before/.test(r.selectors));

/**
 * Every button that must READ as a ☰. Two classes and not one, since the left
 * door stopped sharing `.topic-bar-hamburger` — that class names the rail door
 * and the e2e fixture resolves it with `.first()` (#1073), so a second bearer
 * sent every rail-reaching spec through the wrong door.
 *
 * #1801 took `.topic-bar-windows-opener` OUT of this list, and the removal is
 * the point rather than an omission: #1766 kept the two doors identical
 * because both were "a menu", and with the bottom bar off that left two
 * openers drawn the same at either end of one 48px band. The left one names a
 * specific list, so sameness became the defect. Its own contract is the
 * mirror image of this one and is asserted below.
 */
const BEARERS = ["topic-bar-hamburger", "shell-chrome-rail-opener"];

/** The left door — asserted the other way round throughout (#1801). */
const WINDOWS_OPENER = "topic-bar-windows-opener";

describe("#1766 — the ☰'s three bars are drawn, not typed", () => {
  it("paints them on a ::before of the hamburger", () => {
    const rules = barRules();
    expect(rules.length, "no `.topic-bar-hamburger::before` rule draws the bars").toBeGreaterThan(
      0,
    );
    const body = rules.map((r) => r.body).join("\n");
    expect(body).toMatch(/content:\s*""/);
    expect(body).toMatch(/box-shadow:/);
  });

  // `currentColor`, not `var(--muted)`. `.shell-chrome-btn:hover` /
  // `:focus-visible` lift the button's COLOR to `var(--fg)`; a hardcoded
  // paint would leave the bars dead under the hover the rest of the chrome
  // still answers, and the focus ring would be the only remaining cue.
  it("paints them in currentColor, so hover and focus still answer", () => {
    const body = barRules()
      .map((r) => r.body)
      .join("\n");
    expect(body).toMatch(/background:\s*currentColor/);
    expect(body).toMatch(/box-shadow:[^;]*currentColor/);
  });

  // The bars must scale with the same token the glyph scaled with, or a user
  // on XXL text gets a hamburger frozen at the S size — the very "reads small"
  // complaint, reintroduced one text size up.
  it("sizes them off --chrome-icon-size rather than a fresh magic number", () => {
    const body = barRules()
      .map((r) => r.body)
      .join("\n");
    expect(body).toMatch(/var\(--chrome-icon-size\)/);
  });

  it("suppresses the character, so the glyph and the bars never both paint", () => {
    const suppressors = mentioning("topic-bar-hamburger").filter((r) =>
      /font-size:\s*0/.test(r.body),
    );
    expect(suppressors.length, "nothing zeroes the ☰ character's font-size").toBeGreaterThan(0);
  });

  // THE trap, already documented by #305 for `display`. `.shell-chrome-btn`
  // declares `font-size: var(--chrome-icon-size)` and is declared AFTER
  // `.topic-bar-hamburger` in this file, so a bare `.topic-bar-hamburger` rule
  // ties at (0,1,0) and LOSES on source order — the character would come back
  // at full size under the bars.
  it("wins that suppression against `.shell-chrome-btn`, not merely declares it", () => {
    const base = RULES.find((r) => r.selectors === ".shell-chrome-btn");
    expect(
      base,
      "`.shell-chrome-btn` must exist for this comparison to mean anything",
    ).toBeDefined();
    expect(base?.body).toMatch(/font-size:\s*var\(--chrome-icon-size\)/);

    const suppressors = mentioning("topic-bar-hamburger").filter((r) =>
      /font-size:\s*0/.test(r.body),
    );
    for (const rule of suppressors) {
      const beatsBySpecificity = /\bbutton\.topic-bar-hamburger/.test(rule.selectors);
      const beatsByOrder = rule.index > (base?.index ?? 0);
      expect(
        beatsBySpecificity || beatsByOrder,
        `\`${rule.selectors}\` ties .shell-chrome-btn at (0,1,0) and loses on source order`,
      ).toBe(true);
    }
  });

  // NOT `.topic-bar .topic-bar-hamburger`: good specificity, but it only
  // matches inside the band, and since #1766 the same hamburger also floats in
  // `.shell-chrome` on non-channel windows — where it would render as the thin
  // character next to a drawn twin.
  it("is not scoped to the band, which the leading ☰ now lives outside of", () => {
    for (const rule of barRules()) {
      expect(
        rule.selectors,
        "`.topic-bar `-scoped drawing misses the `.shell-chrome` mount",
      ).not.toMatch(/\.topic-bar\s+\.topic-bar-hamburger[^,{]*::before/);
    }
  });

  // The refusal, stated as a test: the shared token must not have grown a
  // ::before of its own, or every chrome button gets bars.
  it("leaves the shared `.shell-chrome-btn` without a drawn glyph of its own", () => {
    const shared = RULES.filter((r) => /^\.shell-chrome-btn::before$/.test(r.selectors));
    expect(shared).toHaveLength(0);
  });

  // A bearer that fell out of either rule would render as the thin character
  // next to a drawn twin — or, worse, as BOTH at once. Asserted per bearer
  // rather than over the joined text so the failure names which one dropped
  // out. Both surviving bearers are the SAME door (the rail) on its two hosts,
  // which is why they still have to look alike; see WINDOWS_OPENER for the one
  // that deliberately does not.
  it.each(BEARERS)("draws AND suppresses `%s`, so no door drifts", (bearer) => {
    expect(
      barRules().some((r) => r.selectors.includes(bearer)),
      `no ::before rule draws \`.${bearer}\``,
    ).toBe(true);
    expect(
      mentioning(bearer).some((r) => /font-size:\s*0/.test(r.body)),
      `nothing zeroes the character on \`.${bearer}\``,
    ).toBe(true);
  });
});

// #1801 — the LEFT door leaves both rules, and every assertion below is the
// inverse of one above. vjt's ruling: the right ☰ stays generic because it is
// a catch-all, and the left one becomes the ASCII `#` — "il # non emoji / il #
// carattere / ascii / roba anni '70". The character itself is pinned in
// `PaneTopBar.test.tsx`; what lives here is the CSS half.
describe("#1801 — the windows opener is a typed `#`, not a drawn ☰", () => {
  const fontSizeOf = (body: string) => /(?:^|[;{\s])font-size:([^;]*)/.exec(body)?.[1]?.trim();

  // `font-size: 0` IS a font-size, so a filter that merely looks for the
  // property makes the suppression mutant fail BOTH this test and the one
  // above — measured: one mutant, two reds, neither naming which mechanism
  // broke. Suppression is that test's business; this one owns the derivation.
  // Read the VALUE and drop the zero rather than writing a lookahead: `\s*`
  // backtracks to width zero and lets `(?!0…)` pass on ` 0;`, which is a
  // silently vacuous filter (measured too, on the same mutant).
  const sizingRules = () =>
    mentioning(WINDOWS_OPENER).filter((r) => {
      const decl = fontSizeOf(r.body);
      return decl !== undefined && decl !== "0";
    });

  it("draws no bars: nothing gives it a ::before", () => {
    const drawn = barRules().filter((r) => r.selectors.includes(WINDOWS_OPENER));
    expect(
      drawn.map((r) => r.selectors),
      "the left door is a character now — bars under it would paint BOTH",
    ).toEqual([]);
  });

  it("is not zeroed: the character is what paints here", () => {
    const suppressors = mentioning(WINDOWS_OPENER).filter((r) => /font-size:\s*0/.test(r.body));
    expect(
      suppressors.map((r) => r.selectors),
      "`font-size: 0` on the left door renders an empty 48px box",
    ).toEqual([]);
  });

  // The size requirement is the one that cannot be eyeballed. A character's
  // INK is smaller than its em box — measured on the e2e runner's Liberation
  // Mono, `#` is 0.659 em tall — so `font-size: var(--chrome-icon-size)` would
  // paint a `#` ~34% shorter than the bars it stands beside, which is exactly
  // what vjt asked not to happen. The size is therefore DERIVED from the same
  // token, never a fresh px: one knob stays one knob, and a text-size change
  // still moves both glyphs together.
  it("derives its size from --chrome-icon-size rather than a fresh px", () => {
    expect(sizingRules().length, "nothing sizes the left door's character").toBeGreaterThan(0);
    for (const rule of sizingRules()) {
      const decl = fontSizeOf(rule.body) ?? "";
      expect(decl, `\`${rule.selectors}\` sizes the \`#\` off the shared token`).toMatch(
        /var\(--chrome-icon-size\)/,
      );
      expect(decl, `\`${rule.selectors}\` hardcodes a px size for the \`#\``).not.toMatch(/\dpx/);
    }
  });

  // THE trap, same one #305 documented for `display` and #1766 for the
  // suppression: `.shell-chrome-btn` declares `font-size:
  // var(--chrome-icon-size)`, so a bare `.topic-bar-windows-opener` ties at
  // (0,1,0) and the `#` would silently fall back to the un-derived size — a
  // glyph a third too small, with no rule looking wrong.
  it("wins that sizing against `.shell-chrome-btn`, not merely declares it", () => {
    const base = RULES.find((r) => r.selectors === ".shell-chrome-btn");
    expect(
      base,
      "`.shell-chrome-btn` must exist for this comparison to mean anything",
    ).toBeDefined();
    expect(base?.body).toMatch(/font-size:\s*var\(--chrome-icon-size\)/);

    for (const rule of sizingRules()) {
      const beatsBySpecificity = /\bbutton\.topic-bar-windows-opener/.test(rule.selectors);
      const beatsByOrder = rule.index > (base?.index ?? 0);
      expect(
        beatsBySpecificity || beatsByOrder,
        `\`${rule.selectors}\` ties .shell-chrome-btn at (0,1,0) and loses on source order`,
      ).toBe(true);
    }
  });

  // The bars answer `:hover` / `:focus-visible` because they paint in
  // `currentColor`; a character answers for free, by BEING text — but only
  // while nothing pins a colour on it. That is also the measured reason an
  // emoji was refused: a platform-painted glyph ignores `currentColor` and
  // would sit dead under the one lift the rest of the chrome answers.
  it("declares no colour of its own, so the hover lift still reaches it", () => {
    for (const rule of mentioning(WINDOWS_OPENER)) {
      expect(
        rule.body,
        `\`${rule.selectors}\` pins a colour and would go dead under :hover`,
      ).not.toMatch(/(^|[;\s])color:/);
    }
  });

  // Ruling 4: the left door sat flush against the channel name. The clearance
  // goes on the LEADING side only — #1039 pinned the trailing side to
  // `--pane-chrome-inset-*` precisely so the ☰'s two hosts cannot drift apart,
  // and widening the band's own `gap` would have moved that side too.
  it("takes its clearance on the leading side alone", () => {
    const clearance = mentioning(WINDOWS_OPENER).filter((r) => /margin-inline-end:/.test(r.body));
    expect(clearance.length, "nothing separates the left door from the channel name").toBe(1);
    for (const rule of clearance) {
      expect(
        rule.selectors,
        `\`${rule.selectors}\` also matches the trailing door, whose inset #1039 pinned`,
      ).not.toMatch(/topic-bar-hamburger|shell-chrome-rail-opener/);
    }
  });
});
