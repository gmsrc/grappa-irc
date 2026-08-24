// #1704 — a stand-in logo for a station that publishes none.
//
// WHY THIS EXISTS AT ALL. `RadioStation.logoUrl` is nullable since Kohina
// (`radioStations.ts`), and a null needs something to draw. The rule vjt gave
// on #1703 is the whole specification: *"if there are no upstream logos, put a
// set of random placeholders of our own, SVG or similar"*, plus — from the same
// ruling — *"ma che sian consistenti"*, i.e. **stable per station, not random
// per render**. A `Math.random()` pick would change the logo every time the
// drawer opens, and worse, the rail chrome and the picker row would draw two
// different tiles for the same station in the same frame.
//
// WHY A DATA URI. `img-src 'self' data: https:` (GrappaWeb.Plugs.SecurityHeaders,
// re-read 2026-08-24) already admits it, so this costs no server change and no
// second request. Serving the same SVG from our own origin would work under
// `'self'` too; the data URI just skips the round trip.
//
// WHY A HUE AND NOT A HAND-WRITTEN SET, which is a deviation from the letter of
// "a set" and is deliberate. A literal set needs a size K nobody can justify,
// and two logo-less stations collide the moment the table outgrows it. Deriving
// the HUE keeps the two properties the ruling actually asked for — stable per
// station, and distinct between stations — with no constant to pick. It also
// makes the readability claim CHECKABLE rather than eyeballed: saturation and
// lightness are FIXED and only the hue turns, so contrast against the glyph
// cannot depend on which station this is, and `radioLogoPlaceholder.test.ts`
// computes the WCAG ratio across all 360 hues rather than trusting a swatch.
//
// WHY IT READS IN BOTH THEMES. Because it never shows the page behind it: the
// tile is an OPAQUE square, exactly like the 120px logos it stands in for. A
// transparent glyph tinted for one theme is the regression the ruling warned
// about; an opaque tile cannot have it. Nothing here reads a CSS variable —
// an `<img>` renders its SVG as a separate document, where the page's cascade
// does not reach, so a `currentColor` placeholder would come out black.
//
// The MARK is the station's initial rather than an abstract shape, because it
// costs the same and says more: a tile that reads "K" beside the word "Kohina"
// is recognisably that station's, and a lozenge is recognisably nothing.

/** The side of the square, in px. 120 is what the curated table's real logos
    are (`…/logos/120/…`), so a placeholder and a logo occupy the same box. */
const SIDE = 120;

/** Fixed saturation / lightness. ONLY the hue varies — see the module note:
    this is what makes the contrast guarantee independent of the station.
    31% lightness is not a taste: measured across all 360 hues against the
    glyph below, it is the point where the WORST hue (60°, yellow) clears the
    4.5:1 WCAG bar for NORMAL text — 4.71:1, where 32% gives 4.47:1 and misses
    it. A 64px mark in a 120px tile is large text, whose bar is 3:1, so this
    clears the one that applies with the one that does not to spare. Raising it
    weakens yellow first; the test walks every hue rather than trusting this
    sentence. */
const SATURATION = 45;
const LIGHTNESS = 31;

/** The glyph colour. Near-white rather than pure white so the tile does not
    look like a hole punched in a dark theme. */
export const PLACEHOLDER_GLYPH = "#f8f8f8";

/** FNV-1a, 32-bit. Any cheap stable hash satisfies the ruling; this one is
    four lines, has no dependency, and spreads short slugs like ours well.
    `>>> 0` after each step keeps it in unsigned 32-bit space — JavaScript
    bitwise operators yield SIGNED 32-bit, and a negative here would make the
    modulo below produce a negative hue for some ids. */
function hash32(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The hue this station's tile is painted, in degrees.
 *
 * Derived from the `id` — the STABLE slug — and never from the title: a
 * station renamed in the picker must not change colour, and `id` is the field
 * the table already promises is stable (`radioStations.ts`). Exported so the
 * test can measure contrast per station rather than re-deriving it. */
export function placeholderHue(id: string): number {
  return hash32(id) % 360;
}

/** The tile's background, as a CSS colour. */
export function placeholderFill(id: string): string {
  return `hsl(${placeholderHue(id)}, ${SATURATION}%, ${LIGHTNESS}%)`;
}

/** The five characters XML makes special, escaped.
 *
 * The table is ours, so nothing hostile reaches this today — but the output is
 * a DOCUMENT built from a string, and a title beginning `&` or `<` would emit
 * a malformed SVG that renders as nothing at all. Escaping at the boundary is
 * cheaper than the afternoon spent finding out why one row draws blank. */
function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** The station's initial, uppercased — or an empty string when the title has
 * no first character to take.
 *
 * Split by CODE POINT (`[...title]`), not by `charAt`: a title starting with
 * an astral character would otherwise be cut mid-surrogate and produce a lone
 * half that is not a character at all. `toLocaleUpperCase` is deliberately NOT
 * used — this is a graphic mark, not text in the operator's locale, and the
 * Turkish dotless-i mapping would make the same station draw differently for
 * two people looking at the same table. */
export function placeholderInitial(title: string): string {
  return ([...title][0] ?? "").toUpperCase();
}

/**
 * A `data:image/svg+xml` URI for `id`'s tile: an opaque hue-derived square
 * carrying `title`'s initial.
 *
 * Both parameters are required (cic forbids silent-degradation defaults): the
 * id decides the COLOUR because it is stable, and the title supplies the
 * LETTER because it is what a human reads. They are two different jobs and a
 * caller passing one for both would get a tile that moves when the station is
 * renamed.
 */
export function radioLogoPlaceholder(id: string, title: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIDE}" height="${SIDE}" viewBox="0 0 ${SIDE} ${SIDE}">` +
    `<rect width="${SIDE}" height="${SIDE}" fill="${placeholderFill(id)}"/>` +
    `<text x="50%" y="50%" fill="${PLACEHOLDER_GLYPH}" font-family="monospace" font-size="64" ` +
    `text-anchor="middle" dominant-baseline="central">${escapeXml(placeholderInitial(title))}</text>` +
    `</svg>`;
  // `encodeURIComponent` rather than base64: the payload stays readable in the
  // DOM inspector, which matters for a thing whose whole job is to be looked
  // at when something is missing.
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
