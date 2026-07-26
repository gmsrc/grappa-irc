// #274 — the installable PWA ships a real icon set (favicon.ico +
// favicon.svg + maskable 192/512 + apple-touch 180) instead of the
// placeholder "C". This spec proves the SHIPPED ARTIFACTS: it fetches the
// icon surfaces off the dist nginx actually serves and asserts each one is
// present, is the right image format, and has the right pixel dimensions —
// so a broken derivation (missing file, wrong size, an apple-touch that
// regressed back to an SVG iOS ignores, or a manifest that dropped the
// maskable purpose) turns the suite RED.
//
// WHY served-artifact assertions and not a rendered-install check: you
// cannot headlessly install a PWA / mint a WebAPK / scrape an iOS
// home-screen icon, exactly as the #234 manifest spec notes. The provable,
// regression-catching contract is the bytes on the wire. Pixel dimensions
// are read from the PNG IHDR / ICO directory, so the assertions are
// non-vacuous (a 1×1 or an HTML 404 page fails).
//
// Bare @playwright/test (NOT ../fixtures/test): every check is a stateless
// static fetch — no login, no user state — so it skips the vjt-scoped
// fixture's reset/reseed teardown (pure waste + contention here).
import { expect, test } from "@playwright/test";

// PNG: 8-byte signature, then the IHDR chunk (length + "IHDR" + width +
// height as big-endian uint32 at byte offsets 16 and 20).
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngDimensions(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).equals(PNG_SIG), "PNG signature").toBe(true);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function sizeOf(sizes: string): number {
  const n = Number.parseInt(sizes.split("x")[0] ?? "", 10);
  expect(Number.isFinite(n), `parsed size from "${sizes}"`).toBe(true);
  return n;
}

test.describe("#274 real PWA icon set", () => {
  test("served manifest splits any + maskable and every icon is a real PNG at its declared size", async ({
    request,
  }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.status(), "GET /manifest.webmanifest").toBe(200);
    const manifest = await res.json();

    // Non-vacuous: prove we fetched the real cic manifest, not a fallback.
    expect(manifest.id, "manifest.id").toBe("/cic");

    const icons: Array<{ src: string; sizes: string; purpose: string }> =
      manifest.icons;
    expect(Array.isArray(icons) && icons.length > 0, "manifest.icons").toBe(true);

    // #274 contract: a full-bleed `any` set AND a safe-zone `maskable` set,
    // each at 192 and 512, as DISTINCT assets (no combined "any maskable").
    const purposes = icons.map((i) => i.purpose);
    expect(purposes, "an `any` icon exists").toContain("any");
    expect(purposes, "a `maskable` icon exists").toContain("maskable");
    expect(
      purposes.some((p) => p.includes("any") && p.includes("maskable")),
      "no icon carries the combined 'any maskable' purpose",
    ).toBe(false);

    for (const purpose of ["any", "maskable"] as const) {
      const set = icons.filter((i) => i.purpose === purpose);
      expect(
        set.map((i) => i.sizes).sort(),
        `${purpose} set sizes`,
      ).toEqual(["192x192", "512x512"]);
    }

    // Every declared icon must actually be served, be a PNG, and match its
    // advertised pixel dimensions.
    for (const icon of icons) {
      const asset = await request.get(icon.src);
      expect(asset.status(), `GET ${icon.src}`).toBe(200);
      expect(
        asset.headers()["content-type"],
        `${icon.src} content-type`,
      ).toContain("image/png");
      const { width, height } = pngDimensions(await asset.body());
      const n = sizeOf(icon.sizes);
      expect({ src: icon.src, width, height }).toEqual({
        src: icon.src,
        width: n,
        height: n,
      });
    }
  });

  test("apple-touch-icon is a 180×180 PNG (iOS ignores an SVG home-screen icon)", async ({
    request,
  }) => {
    const res = await request.get("/apple-touch-icon.png");
    expect(res.status(), "GET /apple-touch-icon.png").toBe(200);
    expect(res.headers()["content-type"], "content-type").toContain("image/png");
    expect(pngDimensions(await res.body())).toEqual({ width: 180, height: 180 });
  });

  test("favicon.ico is served and is a real ICO container", async ({ request }) => {
    const res = await request.get("/favicon.ico");
    expect(res.status(), "GET /favicon.ico").toBe(200);
    const buf = await res.body();
    // ICONDIR: reserved=0 (2), type=1 icon (2), count>=1 (2), little-endian.
    expect(buf.readUInt16LE(0), "ICO reserved").toBe(0);
    expect(buf.readUInt16LE(2), "ICO type = icon").toBe(1);
    expect(buf.readUInt16LE(4), "ICO image count").toBeGreaterThan(0);
  });

  test("the SVG favicon (/icon.svg — the single source vector) is served", async ({
    request,
  }) => {
    const res = await request.get("/icon.svg");
    expect(res.status(), "GET /icon.svg").toBe(200);
    expect(res.headers()["content-type"], "content-type").toContain("image/svg+xml");
  });

  test("index.html head wires the raster apple-touch + the favicon.ico fallback", async ({
    request,
  }) => {
    const res = await request.get("/");
    expect(res.status(), "GET /").toBe(200);
    const html = await res.text();

    // apple-touch MUST be the raster PNG, never the SVG iOS ignores.
    expect(html, "apple-touch-icon → /apple-touch-icon.png").toMatch(
      /rel="apple-touch-icon"[^>]*href="\/apple-touch-icon\.png"/,
    );
    expect(
      /rel="apple-touch-icon"[^>]*href="\/icon\.svg"/.test(html),
      "apple-touch must NOT point at the SVG",
    ).toBe(false);

    // Legacy favicon.ico fallback + modern SVG favicon both wired.
    expect(html, "favicon.ico link").toContain('href="/favicon.ico"');
    expect(html, "svg favicon link").toMatch(
      /rel="icon"[^>]*type="image\/svg\+xml"[^>]*href="\/icon\.svg"/,
    );
  });
});
