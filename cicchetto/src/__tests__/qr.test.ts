import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { qrSvg } from "../lib/qr";

// #392 — qrSvg wraps uqr's matrix into a self-contained, theme-independent
// SVG (black modules on white, viewBox-scaled). The scannability of the
// symbol is uqr's contract; these tests pin OUR wrapper: correct dims,
// non-empty dark modules, determinism, and the theme-independent colours
// (a QR that inherited a dark theme's colours would render light-on-dark
// and fail camera scanners — the exact bug this asserts against).

const SAMPLE = "https://grappa.example/share/abc123";

describe("qrSvg", () => {
  it("returns an <svg> with a viewBox sized to the QR matrix plus quiet zone", () => {
    const svg = qrSvg(SAMPLE);
    const { size } = encode(SAMPLE, { ecc: "M" });
    // QUIET = 2 modules of margin on every side.
    const dim = size + 4;
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${dim} ${dim}"`);
  });

  it("emits dark modules (finder patterns etc.) as rects", () => {
    const svg = qrSvg(SAMPLE);
    const rectCount = (svg.match(/<rect /g) ?? []).length;
    // Background rect + at least the three finder patterns' worth of modules.
    expect(rectCount).toBeGreaterThan(20);
  });

  it("renders black-on-white regardless of theme (scannability guard)", () => {
    const svg = qrSvg(SAMPLE);
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('fill="#000"');
    // Never inherits theme colour — a light-on-dark QR is unscannable.
    expect(svg).not.toContain("currentColor");
  });

  it("is deterministic for the same input", () => {
    expect(qrSvg(SAMPLE)).toBe(qrSvg(SAMPLE));
  });

  it("encodes a longer payload into a larger matrix", () => {
    const short = encode("x", { ecc: "M" }).size;
    const long = encode(`${SAMPLE}${"z".repeat(200)}`, { ecc: "M" }).size;
    expect(long).toBeGreaterThan(short);
  });
});
