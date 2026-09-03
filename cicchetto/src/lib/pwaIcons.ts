// Single source of truth for the PWA icon set.
//
// Consumed by BOTH the Vite manifest (`vite.config.ts` → `manifest.icons`)
// and the service-worker's Web Push notification (`icon` / `badge`).
//
// S18 (codebase review 2026-07-08): the SW hardcoded
// `/icons/icon-192.png` for the notification `icon`/`badge`, but icons are
// served at the ROOT (`/icon-192.png` — confirmed in `public/`, and what
// the manifest + `index.html` reference). Every Web Push notification thus
// fetched a 404 and rendered the browser's blank glyph. Deriving both the
// manifest AND the notification icon from this ONE module makes a future
// icon rename update them together; `__tests__/pwaIcons.test.ts` asserts
// the any/maskable split + notification tie so a path that would 404 or a
// dropped purpose breaks the test — not the notification, silently.
//
// #274 — the icon PURPOSES are split into distinct assets, per the W3C
// maskable spec: a `maskable` icon must be edge-to-edge with the glyph in
// the central 80% safe zone (so Android's circle/squircle crop never clips
// it), while an `any` icon renders full-bleed. Serving ONE asset as
// "any maskable" (the pre-#274 shape) forced one bitmap to satisfy both,
// so it was either clipped when masked or floating-small when not. The
// `-maskable` PNGs carry the safe-zone padding; the plain PNGs are
// full-bleed. All six raster surfaces (these four + apple-touch + the .ico)
// are DERIVED from `public/icon.svg` by `scripts/gen-pwa-icons.mjs` — swap
// that one SVG and re-run to re-mint the whole set.
export type PwaIconPurpose = "any" | "maskable";

export type PwaIcon = {
  src: string;
  sizes: string;
  type: string;
  purpose: PwaIconPurpose;
};

// The W3C manifest icon list. `src` is a root-absolute path served by the
// static file middleware (nginx in prod, vite in dev). MUST match a real
// file in `public/` — the e2e drift test (`issue274-pwa-icons.spec.ts`)
// fetches every declared `src` off the served dist and asserts 200 + the
// PNG's pixel dimensions match `sizes`.
export const PWA_ICONS: readonly PwaIcon[] = [
  { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
  { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  { src: "/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
  { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
];

// The 192px icon is the Web Push notification `icon` source (the
// notification surface renders small, so the 192 asset is right — the 512
// is for the home-screen install). It is the FULL-BLEED `any` variant, not
// the maskable one: the notification chrome does its own framing, so the
// safe-zone-padded bitmap would render needlessly small. A plain constant,
// NOT re-derived by array-index, so it stays a stable literal; the test
// pins it to a declared manifest `src` so it can never drift to a 404 path.
export const NOTIFICATION_ICON = "/icon-192.png";

// #1906 — the Web Push notification `badge` is a SEPARATE asset, and
// deliberately NOT a manifest icon. `icon` and `badge` are not two sizes of
// one picture: `icon` is the large full-colour image, `badge` is the small
// status-bar glyph, and Android paints the badge through an ALPHA-ONLY mask —
// colour is discarded, every non-transparent pixel gets the system tint.
// Measured on `icon-192.png`: 36864 of 36864 pixels fully opaque, so aliased
// as the badge (the pre-#1906 shape) it could only render as a filled
// square — the white blob reported from the field. iOS/Safari ignores
// `badge` entirely, which is why the defect looked Android-specific.
//
// This PNG is the mark as a one-colour silhouette on a transparent canvas,
// minted from the same `public/icon.svg` by `scripts/gen-pwa-icons.mjs` —
// never traced from the raster (it would drift from the SVG the first time
// the mark changed) and never keyed out of the flattened PNG (fringe alpha
// the mask renders as a halo). 96px is 24dp at xxxhdpi, the largest density
// Android draws the badge at. It carries no manifest `purpose`, so it must
// never be appended to `PWA_ICONS`: `__tests__/pwaIcons.test.ts` pins that
// and the icon/badge split, `__tests__/badgeAsset.test.ts` pins the alpha
// channel of the file itself.
export const NOTIFICATION_BADGE = "/badge-96.png";
