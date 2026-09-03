import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_BADGE, NOTIFICATION_ICON } from "../lib/pwaIcons";

// #1906 — the pixels of the Web Push `badge`, pinned.
//
// Android paints the notification badge through an ALPHA-ONLY mask: colour is
// discarded and every non-transparent pixel gets the system tint. A fully
// opaque PNG under that mask is a filled square — which is exactly what the
// status bar showed while `badge` aliased the full-bleed `icon-192.png`
// (measured: 36864 of 36864 pixels opaque). `pwaIcons.test.ts` pins that the
// SW now names a DIFFERENT file; this file pins that the different file has
// the one property the mask needs — transparency where there is no mark — so
// a regenerate from the full-bleed page (or a hand-dropped opaque PNG under
// the same name) turns RED here instead of shipping the blob again.
//
// The PNG is decoded here rather than in the e2e drift spec because the
// property is in the committed bytes, not in how they are served: Vite copies
// `public/` verbatim. Decoding is hand-rolled (IHDR + inflate + unfilter) for
// the ONE shape `scripts/gen-pwa-icons.mjs` writes — 8-bit, non-interlaced,
// RGB or RGBA — and refuses anything else loudly rather than guessing.

// `cicchetto/`, which is what vitest runs in — the convention the other
// filesystem tests here use (`radioLogoFiles`, `biomePin`, `moduleRootGuard`).
const CIC_ROOT = process.cwd();
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RGB = 2;
const RGBA = 6;

type Decoded = { width: number; height: number; colorType: number; px: Uint8Array; bpp: number };

function readPublic(src: string): Buffer {
  expect(src.startsWith("/"), `${src} is root-served`).toBe(true);
  return readFileSync(resolve(CIC_ROOT, "public", src.slice(1)));
}

function decodePng(buf: Buffer): Decoded {
  expect(buf.subarray(0, 8).equals(PNG_SIG), "PNG signature").toBe(true);
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  expect({ bitDepth, interlace }, "the one PNG shape the generator writes").toEqual({
    bitDepth: 8,
    interlace: 0,
  });
  expect([RGB, RGBA], "truecolour, with or without alpha").toContain(colorType);
  const bpp = colorType === RGBA ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  expect(raw.length, "inflated scanline bytes").toBe(height * (stride + 1));
  const px = new Uint8Array(width * height * bpp);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const line = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const x = line[i] ?? 0;
      const a = i >= bpp ? (cur[i - bpp] ?? 0) : 0;
      const b = prev[i] ?? 0;
      const c = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      cur[i] = v & 0xff;
    }
    px.set(cur, y * stride);
    prev = cur;
  }
  return { width, height, colorType, px, bpp };
}

function alphaAt(d: Decoded, x: number, y: number): number {
  if (d.colorType === RGB) return 255;
  return d.px[(y * d.width + x) * d.bpp + 3] ?? 0;
}

function alphaHistogram(d: Decoded): { transparent: number; opaque: number; partial: number } {
  const out = { transparent: 0, opaque: 0, partial: 0 };
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const a = alphaAt(d, x, y);
      if (a === 0) out.transparent++;
      else if (a === 255) out.opaque++;
      else out.partial++;
    }
  }
  return out;
}

describe("#1906 badge-96.png — an alpha silhouette, not a picture", () => {
  const badge = decodePng(readPublic(NOTIFICATION_BADGE));
  const total = badge.width * badge.height;
  const hist = alphaHistogram(badge);

  it("is 96×96 and carries an alpha channel", () => {
    expect({ width: badge.width, height: badge.height }).toEqual({ width: 96, height: 96 });
    expect(badge.colorType, "RGBA (colour type 6)").toBe(RGBA);
  });

  it("is transparent where there is no mark — every corner, and most of the canvas", () => {
    // The blob regression in one assertion: a full-bleed regenerate has
    // ZERO transparent pixels. The corners are outside the glass in
    // `icon.svg` (the path starts at x=8, y=12 of 64) on every edge.
    for (const [x, y] of [
      [0, 0],
      [badge.width - 1, 0],
      [0, badge.height - 1],
      [badge.width - 1, badge.height - 1],
    ] as const) {
      expect(alphaAt(badge, x, y), `alpha at (${x},${y})`).toBe(0);
    }
    expect(hist.transparent / total, "transparent fraction").toBeGreaterThan(0.5);
  });

  it("has an opaque mark on it (non-vacuous: a blank transparent PNG fails)", () => {
    // The martini silhouette covers roughly a fifth of the viewBox. Bound it
    // from both sides so neither an empty canvas nor a near-filled one passes.
    const opaque = hist.opaque / total;
    expect(opaque, "opaque fraction").toBeGreaterThan(0.05);
    expect(opaque, "opaque fraction").toBeLessThan(0.5);
  });

  it("is monochrome — every painted pixel is the one flattened fill", () => {
    // The generator collapses both SVG fills (glass + olive) to one colour.
    // Android ignores the colour, but a two-tone badge would mean the
    // flatten missed a fill and the asset is no longer a silhouette.
    for (let y = 0; y < badge.height; y++) {
      for (let x = 0; x < badge.width; x++) {
        if (alphaAt(badge, x, y) === 0) continue;
        const i = (y * badge.width + x) * badge.bpp;
        const [r, g, b] = [badge.px[i], badge.px[i + 1], badge.px[i + 2]];
        expect({ x, y, r, g, b }).toEqual({ x, y, r: 255, g: 255, b: 255 });
      }
    }
  });
});

describe("#1906 icon-192.png — the reason the badge cannot be the icon", () => {
  it("is opaque to the last pixel, so under an alpha mask it is a filled square", () => {
    const icon = decodePng(readPublic(NOTIFICATION_ICON));
    const hist = alphaHistogram(icon);
    expect(hist, "alpha histogram of the full-bleed icon").toEqual({
      transparent: 0,
      partial: 0,
      opaque: icon.width * icon.height,
    });
  });
});
