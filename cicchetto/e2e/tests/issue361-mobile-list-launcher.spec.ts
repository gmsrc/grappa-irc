// #361 — mobile list launcher (channel directory / $list) in the drawer
// footer.
//
// Pre-bucket the ONLY way to open the $list channel-directory window on
// the mobile narrow layout was to TYPE `/list` in a channel compose box
// — the desktop sidebar's 📇 $list row has no mobile equivalent. This
// bucket adds a 📇 launcher to the `.mobile-panel-actions` drawer footer
// (the #291 launcher hub) that dispatches the same selection-driven
// navigation the desktop sidebar $list row uses, so DirectoryPane mounts
// and auto-loads. It also MOVES the archive launcher to the END of the
// footer row (archive is the de-emphasised trailing affordance; list
// joins home as a primary window-nav launcher near the left).
//
// This spec drives the real mobile layout (@webkit / iPhone 15): open
// the hamburger drawer, assert the 📇 list launcher is present and is a
// proper ≥44px tap target, assert archive renders LAST in the footer,
// then tap list and assert the drawer closes (mutex) and DirectoryPane
// renders. vjt is NOT promoted to admin — the list launcher is not
// admin-gated, so the base user sees it.

import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import {
  AUTOJOIN_CHANNELS,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
} from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const MIN_TAP_TARGET_PX = 44;

test.setTimeout(60_000);

test.describe("#361 — mobile list launcher in drawer footer", () => {
  test("@webkit list launcher: ≥44px, archive renders LAST, tap opens the $list directory", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    // Open the mobile hamburger → members drawer (hosts the footer).
    await page.getByLabel(/open members sidebar/i).tap();
    const drawer = page.locator(".shell-members.open");
    await expect(drawer).toBeVisible({ timeout: 5_000 });

    const launcherFooter = drawer.locator(".mobile-panel-actions");
    await expect(launcherFooter).toBeVisible();

    // The 📇 list launcher is present (base user, no admin needed).
    const listBtn = launcherFooter.locator("[data-testid='mobile-panel-list']");
    await expect(listBtn).toHaveCount(1);

    // …and a proper mobile tap target (≥44px, rounded — webkit returns
    // sub-pixel fractional widths for a 44px min box).
    const box = await listBtn.boundingBox();
    if (box === null) throw new Error("list launcher has no bounding box");
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
    expect(Math.round(box.height)).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);

    // Archive renders LAST in the footer row (#361 reorder). Read the
    // rendered DOM order of all launchers and assert archive is the tail
    // and list sits ahead of it.
    const testids = await launcherFooter
      .locator(".shell-chrome-btn")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
    expect(testids[testids.length - 1]).toBe("mobile-panel-archive");
    const listIdx = testids.indexOf("mobile-panel-list");
    const archiveIdx = testids.indexOf("mobile-panel-archive");
    expect(listIdx).toBeGreaterThanOrEqual(0);
    expect(listIdx).toBeLessThan(archiveIdx);

    // Tap list → drawer closes (mutex) + the $list DirectoryPane renders
    // (its search box is outside the async <Show when={page()}> guard, so
    // it is immediate — proves the window opened, no throttling change).
    await listBtn.tap();
    await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator(".directory-search")).toBeVisible({ timeout: 5_000 });
  });
});
