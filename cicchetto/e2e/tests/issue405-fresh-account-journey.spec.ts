// #405 — a brand-new, freshly operator-created, non-admin account with NO
// network bound: its FIRST-LOGIN journey, end-to-end through the real cic
// login form. This is the #404 dispatch fix observed in the browser PLUS
// the empty-networks home contract that nobody had exercised before.
//
// Two findings shaped the (focused) scope — see docs/DESIGN_NOTES.md's
// "#404" entry:
//
//   1. The "empty shell, no way forward" the dogfood hit was a SYMPTOM of
//      #404, not a missing feature. Pre-fix a bare account name minted a
//      GUEST session, so HomePane rendered the VISITOR empty-state
//      ("Connecting… pick a network below to get started.") with nothing
//      below = a dead end. With #404 fixed the account lands on the USER
//      empty-state that already exists in HomePane.tsx: "No networks
//      bound. Ask the operator to bind one via bin/grappa bind-network."
//      — the actionable contract this spec pins.
//   2. A fresh-account login mints NO Session.Server (there is no network
//      to connect to) — only an accounts_sessions row — so, unlike a
//      visitor login (feedback_e2e_real_login_poisons_shared_stack), a
//      REAL login here is safe on the shared stack: it dangles no upstream
//      IRC connection to poison downstream specs. The live-IRC portions of
//      the journey (bind → connect → join → send) are covered by the
//      existing seeded-user specs and are OUT of scope here (orchestrator
//      ruling, 2026-07-26). The auth-binding correctness (user-not-guest)
//      is additionally pinned server-side by the #404 RED-first tests in
//      test/grappa_web/controllers/auth_controller_test.exs.
//
// The account (`fresh405`, NO bind) is seeded via the operator mix task
// `grappa.create_user` in cicchetto/e2e/compose.yaml — the SAME ritual an
// operator runs. The spec logs in with the BARE name (no `@`) so the #404
// dispatch (nick → resolve against Accounts → account, not guest) runs
// through the real cic form, unstubbed.

import { type Page, expect, test } from "@playwright/test";
import { FRESH_PASSWORD, FRESH_USER } from "../fixtures/seedData";

async function loginViaForm(page: Page, identifier: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/nick or email/i).fill(identifier);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /^connect$/i }).click();
}

// The visible + storage proof that the login bound a USER (not a guest):
//   * HomePane renders the USER empty-networks copy (a guest renders the
//     visitor "Connecting…" dead-end), AND
//   * the visitor-only welcome block is absent, AND
//   * the persisted `grappa-subject` is `kind: "user"`.
// All three observe rendered DOM / real client state, not a WS frame
// (feedback_e2e_visitor_members_list).
async function expectUserHomeEmptyState(page: Page): Promise<void> {
  const empty = page.getByTestId("home-networks-empty");
  await expect(empty).toBeVisible({ timeout: 15_000 });
  // The actionable USER empty-networks contract (#405) — NOT the guest
  // "Connecting… pick a network below" dead-end.
  await expect(empty).toContainText(/No networks bound/i);
  await expect(empty).toContainText("bin/grappa bind-network");
  await expect(empty).not.toContainText(/Connecting/i);
  // A guest session would render the visitor welcome block; a user must not.
  await expect(page.getByTestId("home-visitor-welcome")).toHaveCount(0);
  // Direct: the account is bound to a USER subject, not a visitor. Pre-#404
  // a bare account name silently minted a visitor here.
  const subjectKind = await page.evaluate(() => {
    const raw = localStorage.getItem("grappa-subject");
    return raw ? (JSON.parse(raw) as { kind?: string }).kind : null;
  });
  expect(subjectKind).toBe("user");
}

test.describe("#405 fresh non-admin account first-login journey", () => {
  test.beforeEach(async ({ page }) => {
    // Suppress the PWA install splash so it doesn't overlay the login form
    // / home (mirrors issue204 + the loginAs seam). addInitScript re-runs
    // on every navigation, so it survives the logout→relogin storage clear.
    await page.addInitScript(() => {
      localStorage.setItem("cic.installChoice", "browser");
    });
  });

  test("bare account name logs in as a USER and shows the actionable empty-networks home", async ({
    page,
  }) => {
    await loginViaForm(page, FRESH_USER, FRESH_PASSWORD);
    await expectUserHomeEmptyState(page);
  });

  test("logout then re-login still binds a USER (no silent guest on the second login)", async ({
    page,
  }) => {
    await loginViaForm(page, FRESH_USER, FRESH_PASSWORD);
    await expectUserHomeEmptyState(page);

    // Real logout: revoke the web session server-side (same-origin fetch,
    // so the page's already-trusted self-signed cert is reused) + clear
    // client auth. Layout-agnostic equivalent of the SettingsDrawer detach
    // button, whose UI is covered by issue126-detach-lifecycle; here we
    // assert the RE-LOGIN dispatch, not the detach chrome.
    await page.evaluate(async () => {
      const token = localStorage.getItem("grappa-token");
      if (token) {
        await fetch("/auth/logout", {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        });
      }
      localStorage.clear();
    });

    // Second login with the bare name again — must ALSO bind a USER. This
    // is the #404 guarantee under repetition: pre-fix the first login's
    // guest held the nick, so the account holder's NEXT attempt
    // 409-collided with their own ghost; post-fix every login resolves to
    // the account.
    await loginViaForm(page, FRESH_USER, FRESH_PASSWORD);
    await expectUserHomeEmptyState(page);
  });
});

// Mobile-webkit smoke (@webkit → iPhone-15 project). The empty-networks
// home + the user-vs-guest branch render on the mobile layout too, where
// chromium/jsdom are blind to mobile CSS (feedback_cicchetto_browser_smoke).
test.describe("#405 fresh account @webkit mobile", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cic.installChoice", "browser");
    });
  });

  test("bare account name logs in as a USER on iPhone", async ({ page }) => {
    await loginViaForm(page, FRESH_USER, FRESH_PASSWORD);
    await expectUserHomeEmptyState(page);
  });
});
