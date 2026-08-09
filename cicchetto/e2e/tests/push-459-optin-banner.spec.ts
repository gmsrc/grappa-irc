// #459 — push opt-in banner on login.
//
// Push notifications are only reachable from settings, so nobody finds them.
// #459 offers them ONCE, on login, in the existing top-banner region:
// "Enable push notifications? [of course!] ×". This spec pins the three
// user-facing outcomes of that banner plus the settings-side availability gate:
//
//   (a) the banner APPEARS on login when the gate is open
//       (pushAvailable() && Notification.permission === "default" && !declined);
//   (b) [of course!] runs the ACCEPT path — it invokes enablePush (which the ×
//       decline never does) and hides the banner, WITHOUT persisting a decline;
//   (c) × DECLINES — the banner leaves and stays gone across a reload, because
//       the decline persists in localStorage;
//   (d) the settings push sub-page disables the master toggle + shows the
//       "unavailable" hint when push is unsupported (same pushAvailable() gate).
//
// Desktop project (untagged → chromium): push is a desktop-tested surface, and
// on iOS pushAvailable() additionally requires a standalone PWA, which the
// webkit-iphone-15 project is not — so the banner would never show there.
//
// Notification stubbing (see fixtures/push.ts stubPushManager for the why):
// chromium headless reports `Notification.permission === "denied"` for the
// getter even without a grant, which would close the banner gate. These specs
// stub the getter to "default" so the gate is open, and stub requestPermission
// to count its calls (the × decline MUST NOT call it — issue rule 2) and
// resolve "default" (the dismissed-prompt outcome: no grant, no throw, no real
// Web-Push vendor round-trip). pushAvailable()'s other inputs (PushManager,
// navigator.serviceWorker) stay native on chromium, so the capability reads as
// present — except in (d), which removes PushManager to simulate the opposite.

import { loginAs, openSettingsSection } from "../fixtures/cicchettoPage";
import { expect, specUser, test } from "../fixtures/test";

// The persisted × decline key (mirrors pushOptin.ts PUSH_OPTIN_DECLINED_KEY).
const PUSH_OPTIN_DECLINED_KEY = "cic.pushOptinDeclined";
// The banner's stable DOM anchor: BannerSlot tags every entry with its source.
const OPTIN_BANNER = '[data-source="push-optin"]';

// Open the banner gate deterministically: Notification present with permission
// "default", requestPermission counted (accept-only) and resolved "default".
// Registered as an initScript so it is in place before cic's first read.
async function stubOptinNotification(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      get: () => "default" as NotificationPermission,
    });
    (window as unknown as { __optinReqPermCalls: number }).__optinReqPermCalls = 0;
    Notification.requestPermission = (async () => {
      (window as unknown as { __optinReqPermCalls: number }).__optinReqPermCalls++;
      return "default" as NotificationPermission;
    }) as typeof Notification.requestPermission;
  });
}

test("#459 — the push opt-in banner offers push on login", async ({ page }) => {
  const vjt = specUser();
  await stubOptinNotification(page);
  await loginAs(page, vjt);

  const banner = page.locator(OPTIN_BANNER);
  await expect(banner).toBeVisible();
  await expect(banner.locator(".error-banner-message")).toHaveText("Enable push notifications?");
  await expect(banner.locator(".error-banner-action")).toHaveText("of course!");
  // The × dismiss affordance is present (its decline semantics are (c)).
  await expect(banner.locator(".error-banner-dismiss")).toBeVisible();
});

test("#459 — [of course!] runs the accept path and does not persist a decline", async ({
  page,
}) => {
  const vjt = specUser();
  await stubOptinNotification(page);
  await loginAs(page, vjt);

  const banner = page.locator(OPTIN_BANNER);
  await expect(banner).toBeVisible();
  await banner.locator(".error-banner-action").click();

  // The accept verb went through enablePush → Notification.requestPermission.
  // The × decline never touches requestPermission (issue rule 2), so a non-zero
  // count is the unambiguous witness that [of course!] took the accept path.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __optinReqPermCalls: number }).__optinReqPermCalls,
      ),
    )
    .toBeGreaterThan(0);

  // Banner hides for the session once the attempt settles.
  await expect(banner).toHaveCount(0);

  // Accept is session-scoped: it MUST NOT persist a decline (that is ×'s job),
  // so the offer can re-appear on a future login where permission is still
  // "default".
  const declined = await page.evaluate((k) => localStorage.getItem(k), PUSH_OPTIN_DECLINED_KEY);
  expect(declined).toBeNull();
});

test("#459 — × declines: banner leaves and stays gone across reload", async ({ page }) => {
  const vjt = specUser();
  await stubOptinNotification(page);
  await loginAs(page, vjt);

  const banner = page.locator(OPTIN_BANNER);
  await expect(banner).toBeVisible();
  await banner.locator(".error-banner-dismiss").click();
  await expect(banner).toHaveCount(0);

  // The decline persists to localStorage (per-browser, not synced).
  const declined = await page.evaluate((k) => localStorage.getItem(k), PUSH_OPTIN_DECLINED_KEY);
  expect(declined).toBe("1");

  // A full reload re-runs the gate (permission still "default", pushAvailable
  // still true) — the persisted decline is what keeps the offer gone.
  await page.reload();
  await expect(page.locator(".sidebar-network-header").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(OPTIN_BANNER)).toHaveCount(0);
});

test("#459 — settings push sub-page disables the toggle + shows the hint when push is unavailable", async ({
  page,
}) => {
  const vjt = specUser();
  // Simulate a browser without Web Push: remove the PushManager constructor so
  // pushAvailable() is false (Notification + serviceWorker alone don't suffice).
  await page.addInitScript(() => {
    Object.defineProperty(window, "PushManager", { configurable: true, value: undefined });
  });
  await loginAs(page, vjt);

  const pushPage = await openSettingsSection(page, "push");
  await expect(pushPage.getByTestId("push-unavailable")).toBeVisible();
  await expect(pushPage.getByTestId("push-master-toggle")).toBeDisabled();
});
