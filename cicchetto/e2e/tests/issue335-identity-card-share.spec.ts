// #335 identity card + native-share — migrated to the #392 share MODAL.
//   1. The "identity" block sits in a titled .settings-section card.
//   2. The settings "share session" button opens the share MODAL (#392
//      reverted #335's sub-page back to a modal, adding a QR); it mints a
//      share link on open. The #335 wrapper card is gone — the entry is now
//      a bare button.
//   3. Inside the modal, a native-share button invokes the Web Share API
//      (navigator.share), falling back to hidden where it's unavailable
//      (the copy button always remains).
//
// All surfaces are visitor-only (the mint endpoint 403s for users and the
// drawer gates identity + share on isVisitor()). This spec mints a throwaway
// visitor, loads its bearer, and drives the settings drawer.
//
// The cross-device mint→consume→both-connected flow is owned by
// visitor-session-sharing.spec.ts; the #392 modal-from-both-triggers + QR is
// owned by issue392-home-restyle-share.spec.ts. Here we retain the
// native-share branch/contract (the unique #335 value). The Web Share API
// branch is verified by stubbing navigator.share (per TESTING.md — assert the
// branch, not device share-sheet pixels): a recording stub for the positive
// case, an explicit deletion for the fallback case, so neither depends on the
// browser default.
//
// Desktop chromium (untagged): the drawer + modal are layout-agnostic and
// navigator.share is a JS API, not a touch gesture.

import { openSettingsDrawer, openSettingsSection } from "../fixtures/cicchettoPage";
import { mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

type VisitorSeed = Awaited<ReturnType<typeof mintVisitor>>;

// Seed a visitor bearer + subject into localStorage before the SPA boots.
async function seedVisitor(page: import("@playwright/test").Page, visitor: VisitorSeed) {
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [visitor.token, JSON.stringify({ kind: "visitor", id: visitor.id })] as const,
  );
}

// Open Settings → tap the "share session" button → the share MODAL opens
// (#392), waiting for the mint to resolve into a /share/ URL.
async function openShareModalFromSettings(page: import("@playwright/test").Page) {
  await openSettingsDrawer(page);
  await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
  await page.getByTestId("share-session-entry").click();
  await expect(page.getByTestId("share-modal")).toBeVisible();
  const url = page.getByTestId("share-url");
  await expect(url).toBeVisible();
  await expect(url).not.toHaveValue("", { timeout: 10_000 });
  return url;
}

test.describe("#335 — visitor identity card + share section + native share", () => {
  test("identity sits in a titled card; share is a bare button (#392)", async ({ page }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`i335-${Date.now()}`);
    try {
      await seedVisitor(page, visitor);
      await page.goto("/");
      await openSettingsDrawer(page);
      await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();

      // #392 dropped the share wrapper card — the share entry is now a bare
      // button, and #460 keeps it on the drawer's main index.
      await expect(page.getByTestId("settings-section-share")).toHaveCount(0);
      await expect(page.getByTestId("share-session-entry")).toBeVisible();

      // #335.1 identity still carded — #460 moved it one tap deeper into the
      // general sub-page. The identity inputs live inside the carded section.
      const generalPage = await openSettingsSection(page, "general");
      await expect(generalPage.getByTestId("settings-section-identity")).toBeVisible();
      await expect(
        generalPage.locator("[data-testid='settings-section-identity'] #settings-nick"),
      ).toBeVisible();
    } finally {
      await reapVisitors(admin.token, visitor.id);
    }
  });

  test("native share invokes navigator.share with the /share/ URL", async ({ page }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`n335-${Date.now()}`);
    try {
      // Recording stub — captures the payload navigator.share was called with.
      await page.addInitScript(() => {
        (window as unknown as { __sharedPayload: unknown }).__sharedPayload = null;
        Object.defineProperty(navigator, "share", {
          configurable: true,
          value: (data: unknown) => {
            (window as unknown as { __sharedPayload: unknown }).__sharedPayload = data;
            return Promise.resolve();
          },
        });
      });
      await seedVisitor(page, visitor);
      await page.goto("/");

      const url = await openShareModalFromSettings(page);
      const shareUrl = await url.inputValue();

      const nativeBtn = page.getByTestId("share-native");
      await expect(nativeBtn).toBeVisible();
      await nativeBtn.click();

      const payload = await page.evaluate(
        () => (window as unknown as { __sharedPayload: { url?: string } | null }).__sharedPayload,
      );
      expect(payload).not.toBeNull();
      expect(payload?.url).toBe(shareUrl);
      expect(payload?.url).toMatch(/\/share\//);
    } finally {
      await reapVisitors(admin.token, visitor.id);
    }
  });

  test("native-share button is hidden when the Web Share API is unavailable", async ({ page }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`f335-${Date.now()}`);
    try {
      // Force the fallback: remove navigator.share so the feature-detect fails
      // regardless of the browser's default.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "share", {
          configurable: true,
          value: undefined,
        });
      });
      await seedVisitor(page, visitor);
      await page.goto("/");

      await openShareModalFromSettings(page);
      // Native button gone; copy remains as the fallback affordance.
      await expect(page.getByTestId("share-native")).toHaveCount(0);
      await expect(page.getByTestId("share-copy")).toBeVisible();
    } finally {
      await reapVisitors(admin.token, visitor.id);
    }
  });
});
