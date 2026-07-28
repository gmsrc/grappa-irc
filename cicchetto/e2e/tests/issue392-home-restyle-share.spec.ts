// #392 — home restyle + session-wide "open on another device" (share) modal.
//
// What this covers (the VISIBLE outcomes jsdom can't see — a real inline
// <svg> QR + the one-modal-two-triggers wiring across the app shell):
//   1. The share MODAL (QR + link + countdown) opens from the SETTINGS
//      "share session" button, and renders a scannable inline-<svg> QR.
//   2. The SAME modal opens from the HOME "open on another device" button
//      (after the network list) — proving one modal, two doors.
//   3. The home network row's Browse channels CTA is a prominent button.
//
// Visitor-only by design (the mint endpoint 403s for users; both triggers
// gate on the visitor subject). The register-nick launcher's action-area
// PLACEMENT is a pure DOM fact verified deterministically in the HomePane
// unit test (it depends on a network's server-side services_flavor, which
// would make an e2e assertion testnet-config-dependent). The cross-device
// mint→consume flow is owned by visitor-session-sharing.spec.ts.
//
// Desktop chromium (untagged): the drawer + modal are layout-agnostic and
// the QR is inline SVG, not a device camera.

import { adminDeleteVisitor, mintVisitor } from "../fixtures/grappaApi";
import { openSettingsDrawer } from "../fixtures/cicchettoPage";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

type VisitorSeed = Awaited<ReturnType<typeof mintVisitor>>;

// Seed a visitor bearer + subject into localStorage before the SPA boots so
// cic lands straight in Shell (no captcha/anon dance).
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

test.describe("#392 — home restyle + session-share modal", () => {
  test("share modal opens from the SETTINGS button with a QR + link", async ({ page }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`i392s-${Date.now()}`);
    try {
      await seedVisitor(page, visitor);
      await page.goto("/");

      await openSettingsDrawer(page);
      await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
      await page.getByTestId("share-session-entry").click();

      await expect(page.getByTestId("share-modal")).toBeVisible();
      // The QR renders as an inline <svg> built from the minted /share/ URL.
      await expect(page.getByTestId("share-qr").locator("svg")).toBeVisible({ timeout: 10_000 });
      const url = page.getByTestId("share-url");
      await expect(url).not.toHaveValue("", { timeout: 10_000 });
      expect(await url.inputValue()).toMatch(/\/share\//);
    } finally {
      await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
    }
  });

  test("the SAME share modal opens from the HOME button with a QR", async ({ page }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`i392h-${Date.now()}`);
    try {
      await seedVisitor(page, visitor);
      await page.goto("/");

      // Land on the home pane (desktop sidebar home link) before tapping the
      // bottom-of-home share button.
      await page.locator(".sidebar-home-btn").first().click();
      await expect(page.locator(".home-pane-registered").first()).toBeVisible({ timeout: 10_000 });

      await page.getByTestId("home-share-session").click();
      await expect(page.getByTestId("share-modal")).toBeVisible();
      await expect(page.getByTestId("share-qr").locator("svg")).toBeVisible({ timeout: 10_000 });
    } finally {
      await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
    }
  });

  test("connected network row shows a prominent Browse channels button", async ({ page }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`i392b-${Date.now()}`);
    try {
      await seedVisitor(page, visitor);
      await page.goto("/");

      await page.locator(".sidebar-home-btn").first().click();
      await expect(page.locator(".home-pane-registered").first()).toBeVisible({ timeout: 10_000 });

      const row = page.locator(".home-pane-network-row").filter({ hasText: visitor.network_slug });
      const browse = row.getByRole("button", { name: /browse channels/i }).first();
      await expect(browse).toBeVisible({ timeout: 10_000 });
      // #392 — the Browse CTA carries the prominent accent-outlined class.
      await expect(browse).toHaveClass(/home-pane-network-browse/);
    } finally {
      await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
    }
  });
});
