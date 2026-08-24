import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_GLYPH,
  placeholderFill,
  placeholderHue,
  placeholderInitial,
  radioLogoPlaceholder,
} from "../lib/radioLogoPlaceholder";
import { RADIO_STATIONS } from "../lib/radioStations";

// #1704 — the stand-in logo, and the two properties vjt's #1703 ruling asked
// for by name: stable per station ("ma che sian consistenti"), and readable in
// BOTH themes.
//
// The readability half is COMPUTED here rather than eyeballed, which is the
// whole reason the module fixes saturation and lightness and turns only the
// hue: the worst case is then a hue, and a test can walk all 360 of them. A
// hand-picked set of swatches could not be checked this way — someone would
// have had to look at each one and say "fine".

/** sRGB channel → linear light, per WCAG 2.x relative-luminance. */
const linear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const luminance = (r: number, g: number, b: number): number =>
  0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** `hsl(h, s%, l%)` → the three sRGB channels in 0..1. The CSS conversion,
    written out because jsdom computes no colours and the test must not depend
    on a browser to know what it asked for. */
const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sextant = Math.floor(h / 60) % 6;
  const table: ReadonlyArray<readonly [number, number, number]> = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = table[sextant] ?? [0, 0, 0];
  return [r + m, g + m, b + m];
};

const hexToRgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
];

const contrast = (a: [number, number, number], b: [number, number, number]): number => {
  const la = luminance(...a);
  const lb = luminance(...b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

/** Read `hsl(h, s%, l%)` back out of the production string, so the test
    measures what the module EMITS rather than a copy of its constants. */
const parseHsl = (css: string): [number, number, number] => {
  const m = css.match(/^hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)$/);
  if (m === null) throw new Error(`not an hsl() the test can read: ${css}`);
  return [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
};

describe("the placeholder logo is stable per station (#1704)", () => {
  it("gives the same station the same tile every time it is asked", () => {
    // The ruling's own words. A `Math.random()` pick would redraw on every
    // open of the drawer, and would put two different tiles for one station on
    // screen at once — the rail chrome and the picker row render separately.
    const first = radioLogoPlaceholder("kohina", "Kohina");
    const second = radioLogoPlaceholder("kohina", "Kohina");
    expect(second).toBe(first);
  });

  it("gives different stations different tiles", () => {
    const hues = RADIO_STATIONS.map((s) => placeholderHue(s.id));
    // Not "all distinct" — 21 ids into 360 hues will collide eventually and a
    // collision is not a defect (a placeholder is not an identity). What would
    // be a defect is a hash that answers the same thing for everything.
    expect(new Set(hues).size).toBeGreaterThan(1);
  });

  it("keys the COLOUR on the id and the MARK on the title — two jobs, two fields", () => {
    // `id` is the field the table promises is stable; `title` is display. So a
    // station renamed in the picker keeps its colour and only its letter can
    // move, and two stations with the same initial still differ by hue.
    const fill = placeholderFill("kohina");
    expect(decodeURIComponent(radioLogoPlaceholder("kohina", "Kohina"))).toContain(fill);
    expect(decodeURIComponent(radioLogoPlaceholder("kohina", "Zohina"))).toContain(fill);
    // The letter followed the rename; the colour did not.
    expect(decodeURIComponent(radioLogoPlaceholder("kohina", "Zohina"))).toContain(">Z</text>");
    expect(placeholderFill("kohina")).not.toBe(placeholderFill("kohina-2"));
  });

  it("never derives a negative hue, whatever the id", () => {
    // The signed-32-bit trap: JS bitwise operators return SIGNED values, and a
    // negative modulo would emit `hsl(-137, …)`, which is not a colour.
    for (const id of [...RADIO_STATIONS.map((s) => s.id), "", "ÿÿÿÿ", "\u{1F4FB}", "zzzzzzzzzz"]) {
      const hue = placeholderHue(id);
      expect(hue, `id ${JSON.stringify(id)} produced hue ${hue}`).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe("the placeholder logo reads in both themes (#1704)", () => {
  it("is OPAQUE, so the page behind it cannot decide whether it is legible", () => {
    // The mechanism, not a proxy for it: a full-bleed rect at the tile's own
    // size means no theme background shows through, which is what makes the
    // contrast measured below the ONLY contrast that matters.
    const svg = decodeURIComponent(
      radioLogoPlaceholder("kohina", "Kohina").replace("data:image/svg+xml,", ""),
    );
    expect(svg).toContain('<rect width="120" height="120"');
    expect(svg).not.toContain("fill-opacity");
    expect(svg).not.toContain("currentColor");
  });

  it("clears the WCAG NORMAL-text bar at EVERY hue, not just the ones we shipped", () => {
    // The reason saturation and lightness are fixed and only the hue turns:
    // the worst case is a hue, so it can be enumerated. The bar that APPLIES
    // is 3:1 (AA, large text — a 64px glyph in a 120px tile is large by any
    // reading), and the lightness was chosen so the worst hue clears 4.5:1,
    // the bar for normal text, instead. Asserted at 4.5 rather than at 3
    // because that is the property the constant was picked for: at 32%
    // lightness hue 60 measures 4.47:1 and this test would go red, which is
    // the point. A test over the current table alone would never see hue 60
    // until someone added a station whose slug hashed there.
    const glyph = hexToRgb(PLACEHOLDER_GLYPH);
    const worst = { hue: -1, ratio: Number.POSITIVE_INFINITY };
    for (let hue = 0; hue < 360; hue++) {
      // Through the production string, so a change to S or L is measured here
      // rather than re-typed.
      const [, s, l] = parseHsl(placeholderFill("probe"));
      const ratio = contrast(hslToRgb(hue, s, l), glyph);
      if (ratio < worst.ratio) {
        worst.hue = hue;
        worst.ratio = ratio;
      }
    }
    expect(
      worst.ratio,
      `worst hue is ${worst.hue} at ${worst.ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the placeholder logo's mark (#1704)", () => {
  it("carries the station's initial", () => {
    const svg = decodeURIComponent(radioLogoPlaceholder("kohina", "Kohina"));
    expect(svg).toContain(">K</text>");
  });

  it("uppercases a lowercase title without consulting a locale", () => {
    // `toUpperCase`, never `toLocaleUpperCase`: under a Turkish locale the
    // latter maps `i` to `İ`, so the same station would draw a different mark
    // for two people reading the same table.
    expect(placeholderInitial("indie pop")).toBe("I");
  });

  it("takes a whole code point, not half a surrogate pair", () => {
    // `charAt(0)` on an astral character yields a lone surrogate, which is not
    // a character and renders as a replacement box.
    expect(placeholderInitial("📻 Radio")).toBe("📻");
  });

  it("survives a title with no characters at all", () => {
    expect(placeholderInitial("")).toBe("");
    expect(() => radioLogoPlaceholder("x", "")).not.toThrow();
  });

  it("escapes XML metacharacters instead of emitting a malformed document", () => {
    // A title beginning `&` or `<` would otherwise produce an SVG that renders
    // as nothing — a blank tile where the failure is invisible, which is the
    // opposite of what a placeholder is for.
    const svg = decodeURIComponent(radioLogoPlaceholder("amp", "& Friends"));
    expect(svg).toContain(">&amp;</text>");
    expect(svg).not.toContain(">&</text>");
  });

  it("is a data: URI, which the CSP already admits", () => {
    // `img-src 'self' data: https:` — re-read on GrappaWeb.Plugs.SecurityHeaders
    // 2026-08-24. Pinned as a shape so a later switch to a fetched asset has to
    // face the CSP question deliberately rather than at runtime in prod.
    expect(radioLogoPlaceholder("kohina", "Kohina")).toMatch(/^data:image\/svg\+xml,/);
  });
});
