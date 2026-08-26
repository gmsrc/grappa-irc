// #1828 — the radio band carries ONE horizontal inset, on the logo, as padding.
//
// WHAT THE DEFECT WAS. The station logo read as further left than the nick rows
// stacked above it while both sat on the same 7px `--rail-inset`. Nothing was
// misaligned: the logo is an image whose pixels start at its box edge, a nick is
// monospace text whose glyphs carry a left side bearing, so an image flush to an
// inset the glyph beside it only approaches reads as further out. The cure is an
// OPTICAL nudge of the logo's ink, not a geometry change.
//
// WHY THAT NUDGE IS A PADDING AND NOT A MARGIN, which is the half of the ruling
// worth guarding. The logo and the title are consecutive flex items, so the
// space has to come out of one of them: a MARGIN takes it from the row and
// carries the title (and the track line under it) right with the logo, a PADDING
// takes it from the logo's own content box and moves nothing else. The issue
// forbids moving the title, so padding it is — at the measured cost of the image
// rendering 2.1px narrower inside an unchanged 2rem box (`object-fit: cover`, so
// the artwork is cropped, never distorted).
//
// WHAT IS DELIBERATELY NOT ASSERTED: the SIZE of the nudge. It is an optical
// value that only an eye on a real render can judge, and a test that re-read
// `0.15rem` off the sheet it is reading would be a mirror of the fix rather than
// a statement about it. These two tests name a property no band box may carry
// and a mechanism the one allowed inset must use; the value is free to move.

import { describe, expect, it } from "vitest";
import { allRules, horizontalInsets, isZeroInset, selectorList } from "./helpers/themeCss";

const LOGO = ".rail-radio-now-logo";

// The band is `.rail-radio` and its own children — the identity button, the
// logo, the two text lines and the ⏹. The PICKER that overlays the rail is a
// different surface and out of scope by the issue's own ruling: its rows carry
// `padding: 0.25rem 0.375rem` of their own and must keep it.
const BAND = /\.rail-radio(?!-picker|-heading|-station)[\w-]*/;

/** Every rule that styles a box inside the band, picker rules excluded. */
function bandRules(): { selectors: string; body: string }[] {
  return allRules().filter((rule) => selectorList(rule.selectors).some((one) => BAND.test(one)));
}

/** The band's declared horizontal insets as `selectors → property` strings. */
function declaredInsets(rules: { selectors: string; body: string }[]): string[] {
  return rules.flatMap((rule) =>
    horizontalInsets(rule.body)
      .filter(({ component }) => !isZeroInset(component))
      .map(({ property }) => `${rule.selectors} → ${property}`),
  );
}

describe("#1828 — the radio band's one horizontal inset", () => {
  it("keeps every band surface except the logo on the rail's own inset", () => {
    const rules = bandRules();
    // Positive control, and the reason this is not vacuous: an over-tight BAND
    // pattern would satisfy the assertion below by matching nothing at all.
    expect(rules.map((rule) => rule.selectors)).toContain(".rail-radio-now");

    // #1737 moved the band's horizontal padding to `.shell-members` so its
    // border box lines up with every other rail surface, and the tempting cure
    // for THIS issue is to put it straight back — which would re-bleed the band
    // and move the title, the track line and the ⏹ with it. Anything in the band
    // that insets itself horizontally, other than the logo, is that regression.
    const offenders = declaredInsets(rules.filter((rule) => !rule.selectors.includes(LOGO)));
    expect(offenders).toEqual([]);
  });

  it("insets the logo's content with a padding, never its box with a margin", () => {
    const logoRules = bandRules().filter((rule) => rule.selectors.includes(LOGO));
    const insets = logoRules.flatMap((rule) =>
      horizontalInsets(rule.body).filter(({ component }) => !isZeroInset(component)),
    );

    // The nudge has to EXIST — without this the pair passes cleanly on a sheet
    // where somebody deleted the fix, which is the one regression a source test
    // of an optical correction can still catch.
    expect(insets.length).toBeGreaterThan(0);
    expect(insets.map(({ property }) => property.replace(/-(left|inline-start)$/, ""))).toEqual(
      insets.map(() => "padding"),
    );
  });
});
