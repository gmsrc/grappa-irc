// #361 — rooms launcher (channel directory / $list) in the rail actions
// drawer.
//
// Pre-#361 the ONLY way to open the $list channel-directory window on the
// mobile narrow layout was to TYPE `/list` in a channel compose box — the
// desktop sidebar's 📇 $list row had no mobile equivalent. #361 added a 📇
// launcher that dispatches the same selection-driven navigation the desktop
// sidebar $list row uses, so DirectoryPane mounts and auto-loads.
//
// #473 folded every rail affordance into ONE `.rail-actions` drawer at the
// bottom of `.shell-members` (present on both form factors). The launcher keeps
// its `mobile-panel-list` testid but is now labelled "rooms". #473 also
// re-ordered the rail — home · rooms · themes · archive · settings · admin ·
// denoise — so the #361 "archive moved to the END" reorder no longer holds
// (settings/denoise now trail archive). What DOES hold is #361's intent: rooms
// joins home as a primary window-nav launcher at the FRONT of the rail, while
// archive is a de-emphasised affordance further down.
//
// This spec drives the real mobile layout (@webkit / iPhone 15): open the
// drawer, assert the 📇 rooms launcher is present and a proper ≥44px tap
// target, assert it leads the rail right after home (and ahead of archive),
// then tap it and assert the drawer closes (mutex) and DirectoryPane renders.
// vjt is NOT promoted to admin — the rooms launcher is not admin-gated, so the
// base user sees it.

import { loginAs, openRailMenu, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const MIN_TAP_TARGET_PX = 44;

test.setTimeout(60_000);

test.describe("#361 — rooms launcher in the rail actions drawer", () => {
  test("@webkit @touch rooms launcher: ≥44px, leads the rail after home, tap opens the $list directory", async ({
    page,
  }) => {
    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    // Open the mobile hamburger → members drawer (hosts the rail).
    await page.getByLabel(/open members sidebar/i).tap();
    const drawer = page.locator(".shell-members.open");
    await expect(drawer).toBeVisible({ timeout: 5_000 });

    const rail = drawer.locator(".rail-actions");
    await expect(rail).toBeVisible();

    // #500 — the rail affordances collapsed behind ONE launcher; reveal the menu
    // (openRailMenu sees the drawer is already open and just taps the launcher).
    // The buttons live inside `.rail-actions-menu` now.
    await openRailMenu(page);
    const menu = drawer.locator(".rail-actions-menu");
    await expect(menu).toBeVisible();

    // The 📇 rooms launcher is present (base user, no admin needed). It keeps
    // the `mobile-panel-list` testid though it's labelled "rooms" now (#473).
    const listBtn = menu.locator("[data-testid='mobile-panel-list']");
    await expect(listBtn).toHaveCount(1);

    // …and a proper mobile tap target (≥44px, rounded — webkit returns
    // sub-pixel fractional widths for a 44px min box).
    const box = await listBtn.boundingBox();
    if (box === null) throw new Error("rooms launcher has no bounding box");
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
    expect(Math.round(box.height)).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);

    // #473 reordered the rail: rooms joins home as a primary window-nav
    // launcher at the FRONT (home first, rooms directly after), while archive
    // is de-emphasised further down. Archive is NO LONGER the tail — #473 puts
    // settings/denoise after it, retiring the #361 "archive last" reorder. Read
    // the rendered DOM order and assert the front-of-rail position + that rooms
    // sits ahead of archive. #500 — scope to `.rail-actions-menu`: the pinned
    // launcher ALSO carries `.shell-chrome-btn` but lives OUTSIDE the menu, so
    // the menu-scoped list is exactly the action buttons in render order.
    const testids = await menu
      .locator(".shell-chrome-btn")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
    expect(testids[0]).toBe("mobile-panel-home");
    expect(testids[1]).toBe("mobile-panel-list");
    expect(testids.indexOf("mobile-panel-list")).toBeLessThan(
      testids.indexOf("mobile-panel-archive"),
    );

    // Tap rooms → drawer closes (mutex) + the $list DirectoryPane renders (its
    // search box is outside the async <Show when={page()}> guard, so it is
    // immediate — proves the window opened, no throttling change).
    await listBtn.tap();
    await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator(".directory-search")).toBeVisible({ timeout: 5_000 });
  });
});
