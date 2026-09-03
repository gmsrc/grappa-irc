import { describe, expect, it } from "vitest";
import { pushNotificationOptions } from "../lib/pushPayload";
import { NOTIFICATION_BADGE, NOTIFICATION_ICON, PWA_ICONS } from "../lib/pwaIcons";

// S18 (codebase review 2026-07-08) — the service-worker's Web Push
// notification pointed `icon`/`badge` at `/icons/icon-192.png`, but icons
// are served at the ROOT (`/icon-192.png`, per `public/` + the manifest).
// Every notification fetched a 404 and rendered the browser's blank glyph.
//
// These tests TIE the SW notification icon to the manifest icon set, which is
// the single source shared with the Vite manifest (`vite.config.ts` imports
// the same `PWA_ICONS`). So the SW and the manifest cannot drift: if a future
// change re-hardcodes a path in the SW that isn't a declared manifest icon,
// the tie test fails. (File existence + served pixel dimensions are enforced
// downstream by the e2e spec `issue274-pwa-icons.spec.ts`, which fetches
// every declared `src` off the built dist — that needs Node fs / a real
// server, which the browser-target cic tsconfig has no types for.)
describe("PWA icons — S18 notification icon ↔ manifest tie", () => {
  const opts = pushNotificationOptions({ title: "t", body: "b", tag: "x", url: "/foo" });

  it("the SW notification icon is a declared manifest icon (no drift)", () => {
    expect(PWA_ICONS.map((i) => i.src)).toContain(opts.icon);
  });

  it("the SW notification icon resolves to the single NOTIFICATION_ICON source", () => {
    expect(opts.icon).toBe(NOTIFICATION_ICON);
  });

  it("NOTIFICATION_ICON is a manifest-declared icon (root-served path, not /icons/…)", () => {
    expect(PWA_ICONS.map((i) => i.src)).toContain(NOTIFICATION_ICON);
    // Guard the exact S18 regression: the notification icon must be a
    // root-served path, never the 404 `/icons/…` prefix the SW used to carry.
    expect(NOTIFICATION_ICON.startsWith("/icons/")).toBe(false);
  });
});

// #274 — the manifest icon set splits `any` (full-bleed) from `maskable`
// (safe-zone padded) into distinct assets. The pre-#274 shape served ONE
// bitmap as "any maskable", which was either clipped when the platform
// masked it or floating-small when it didn't. These assertions pin the
// split so nobody collapses it back to a single combined-purpose asset.
describe("PWA icons — #274 any/maskable purpose split", () => {
  const bySrc = (s: string) => PWA_ICONS.find((i) => i.src === s);

  // NOTE: "no icon carries the combined 'any maskable' purpose" is enforced
  // at the TYPE level (`PwaIconPurpose = "any" | "maskable"`) here, so a
  // runtime assertion of it would only mirror the compiler. The teeth for
  // the served manifest STRING (where the type doesn't apply) live in the
  // e2e spec `issue274-pwa-icons.spec.ts`.
  it("declares a full-bleed `any` set at 192 and 512", () => {
    const any = PWA_ICONS.filter((i) => i.purpose === "any");
    expect(any.map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    expect(any.every((i) => i.type === "image/png")).toBe(true);
  });

  it("declares a safe-zone `maskable` set at 192 and 512 (distinct assets)", () => {
    const maskable = PWA_ICONS.filter((i) => i.purpose === "maskable");
    expect(maskable.map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    // The maskable assets must be SEPARATE files from the `any` ones —
    // sharing one file is exactly the clip-or-float bug #274 removes.
    for (const m of maskable) {
      const any = PWA_ICONS.find((i) => i.purpose === "any" && i.sizes === m.sizes);
      expect(m.src).not.toBe(any?.src);
      expect(m.src).toContain("maskable");
    }
  });

  it("the notification icon is the full-bleed `any` 192 (not the maskable one)", () => {
    const notif = bySrc(NOTIFICATION_ICON);
    expect(notif?.purpose).toBe("any");
    expect(notif?.sizes).toBe("192x192");
  });
});

// #1906 — the notification `badge` is NOT the icon. Android renders the
// badge through an alpha-only mask, so the full-bleed opaque `icon-192.png`
// aliased into `badge` painted a solid white square in the status bar. The
// pre-#1906 tie test above asserted `badge === NOTIFICATION_ICON` and so
// PASSED on the defect; these assertions are the ones that would have
// caught it. The pixels of the asset itself are pinned in
// `badgeAsset.test.ts`.
describe("PWA icons — #1906 the notification badge is its own alpha-mask asset", () => {
  const opts = pushNotificationOptions({ title: "t", body: "b", tag: "x", url: "/foo" });

  it("the SW notification badge is NOTIFICATION_BADGE, distinct from the icon", () => {
    expect(opts.badge).toBe(NOTIFICATION_BADGE);
    expect(opts.badge).not.toBe(opts.icon);
    expect(NOTIFICATION_BADGE).not.toBe(NOTIFICATION_ICON);
  });

  it("NOTIFICATION_BADGE is a root-served path (S18) and NOT a manifest icon", () => {
    expect(NOTIFICATION_BADGE.startsWith("/")).toBe(true);
    expect(NOTIFICATION_BADGE.startsWith("/icons/")).toBe(false);
    // A badge carries no manifest `purpose` — appending it to `PWA_ICONS`
    // would advertise an alpha silhouette as an installable app icon.
    expect(PWA_ICONS.map((i) => i.src)).not.toContain(NOTIFICATION_BADGE);
  });
});
