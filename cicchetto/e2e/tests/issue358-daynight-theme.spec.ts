// #358 — day/night theme pairing. A gallery theme should follow the OS
// `prefers-color-scheme` the way the base [data-theme] already does: the user
// picks a DAY theme + a NIGHT theme and cicchetto swaps the applied gallery
// layer automatically when the OS flips light/dark — no scheduler, no
// geolocation, just the media query.
//
// This drives the REAL browser: pick a distinct day + night gallery built-in
// via the pairing UI, then emulate the OS color-scheme flipping light↔dark and
// assert the inline `--bg` custom property (the gallery layer customTheme.ts
// writes on <html>) actually SWAPS between the two themes — a hollow "it went
// green" spec would pass without the swap, so we pin the exact day vs night
// values. The pair is proven SERVER-owned (like #75): the localStorage FOUC
// mirror is cleared before reload, so the post-reload swap can only come from
// GET /me/theme.

import { loginAs, openRailMenu, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(60_000);

// The inline `--bg` custom property customTheme.ts writes on <html> for the
// currently-resolved slot. Empty string when no custom theme is applied.
function readInlineBg(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => document.documentElement.style.getPropertyValue("--bg").trim());
}

async function openThemesSubPage(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel(/open members sidebar/i).tap();
  const drawer = page.locator(".shell-members.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  await openRailMenu(page);
  await page.locator(".rail-actions-menu [data-testid='action-cluster-cog']").tap();
  await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
  await page.getByTestId("themes-settings-entry").tap();
  await expect(page.getByTestId("theme-gallery")).toBeVisible({ timeout: 5_000 });
}

test.describe("#358 — day/night theme pairing", () => {
  test("@webkit @touch the gallery layer swaps with the OS color scheme (server-owned pair)", async ({
    page,
  }) => {
    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    // Start deterministically in light mode so the "day" slot is what paints.
    await page.emulateMedia({ colorScheme: "light" });

    await openThemesSubPage(page);

    // Two gallery built-ins in gallery order — the stable distinct-bg pair
    // (same rationale as the #75 gallery spec: scope to the gallery section so
    // an earlier spec's owned theme can't straddle the positional index).
    const selectButtons = page
      .getByTestId("theme-section-gallery")
      .locator("[data-testid^='theme-select-']");
    await expect(selectButtons.first()).toBeVisible({ timeout: 5_000 });
    expect(await selectButtons.count()).toBeGreaterThanOrEqual(2);

    // Pick the DAY theme (single pick → applies in both modes for now).
    await selectButtons.nth(0).tap();
    await expect.poll(() => readInlineBg(page), { timeout: 5_000 }).not.toBe("");
    const bgDay = await readInlineBg(page);

    // Toggle "use a different theme at night" → the slot selector targets the
    // night slot and previews it live.
    await page.getByTestId("theme-daynight-toggle").check();
    await expect(page.getByTestId("theme-slot-night")).toBeVisible({ timeout: 5_000 });

    // Pick a DIFFERENT theme for the NIGHT slot → live preview shows it.
    await selectButtons.nth(1).tap();
    await expect.poll(() => readInlineBg(page), { timeout: 5_000 }).not.toBe(bgDay);
    const bgNight = await readInlineBg(page);
    expect(bgNight).not.toBe("");

    // Clear the localStorage FOUC mirror so the post-reload pair can ONLY come
    // from the server (GET /me/theme) — proves BOTH slots persist cross-device.
    // Reload also drops the in-gallery preview override, so the OS media query
    // is the sole driver of which slot paints from here on.
    await page.evaluate(() => localStorage.removeItem("grappa-custom-theme"));
    await page.reload();

    // Light OS → the DAY slot paints (re-fetched from the server).
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => readInlineBg(page), { timeout: 10_000 }).toBe(bgDay);

    // Flip the OS to dark → the NIGHT slot paints live, no re-fetch.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => readInlineBg(page), { timeout: 10_000 }).toBe(bgNight);

    // Flip back to light → the DAY slot returns. The swap is bidirectional.
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => readInlineBg(page), { timeout: 10_000 }).toBe(bgDay);
  });
});
