// #1040 — on the HOME window the rail actions are expanded, in flow, with the
// buttons visible. Everywhere else #500's launcher stays the single door.
//
// The trap this spec is built around: "expanded" is trivially fakeable by
// leaving the overlay OPEN. That build would satisfy any assertion of the shape
// "the cog is visible on home" while shipping a popover pinned to the bottom
// edge of the rail, floating over an empty column, still capped by a max-height
// measured for a menu that opens upward. So the oracle here is CONTAINMENT, not
// visibility: `.rail-actions-menu` must lie inside the box of its
// `.rail-actions` container. That is true only in normal flow — the container
// wraps a static child and grows to it. With the menu still `position:
// absolute; bottom: 100%`, the container is a launcher-tall strip and the menu
// sits entirely ABOVE it, so its top is a few hundred px past the container's
// and this fails.
//
// The second test is the exception's fence: a channel window must still open
// the way #500 left it — launcher present, menu absent until tapped, and when
// tapped it floats ABOVE the launcher rather than in flow. Without it, "expand
// the rail" could quietly become "expand the rail everywhere", which is the
// regression #500 exists to prevent (a big channel's nick list back under the
// fold).
//
// Both form factors, because the issue asks for both and the mount sites
// differ: on desktop the rail is a permanent grid column, on mobile it is the
// slide-in drawer. The `@webkit` third test is the mobile arm (only tagged
// specs reach the iPhone project); the geometry oracle stays on the desktop one
// — inside a transformed, animating drawer a box comparison measures the slide
// as much as the layout.
//
// NOT claimed here: the felt result on a real phone. Playwright's webkit is not
// iOS Safari (no real momentum, no notch — `env()` resolves to 0), so whether
// the column reads well under a thumb, and whether a short device scrolls it
// comfortably, are vjt's device-verify calls.

import { loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0]; // #spec-wN — the per-spec autojoin channel

test("#1040 — the home rail lays its actions out expanded, in flow, with no launcher", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Precondition: cold load lands on the home window. Without this the test
  // could be measuring some other kind's rail and pass for the wrong reason.
  await expect(page.locator(".home-pane")).toBeVisible({ timeout: 15_000 });

  // Called for its POST-CONDITION, not its gesture: on home it taps nothing,
  // because there is no launcher to tap. Going through the shared door anyway
  // keeps this spec honest about what every other spec's path now does here.
  await openRailMenu(page);

  const rail = page.locator(".rail-actions");
  const menu = page.locator(".rail-actions-menu");
  await expect(menu).toBeVisible();

  // THE ASK: the buttons are visible, reached with no interaction.
  await expect(page.getByTestId("action-cluster-cog")).toBeVisible();
  await expect(page.getByTestId("mobile-panel-home")).toBeVisible();
  await expect(page.getByTestId("mobile-panel-archive")).toBeVisible();

  // And the door is gone — on home it could only ever COLLAPSE the column this
  // issue exists to expand.
  await expect(page.getByTestId("rail-actions-launcher")).toHaveCount(0);

  // THE SHAPE: in flow, not a popover left open. The container must actually
  // contain the column.
  const railBox = await rail.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(railBox, "the rail container must have a layout box").not.toBeNull();
  expect(menuBox, "the action column must have a layout box").not.toBeNull();
  if (railBox && menuBox) {
    expect(
      menuBox.y,
      "the column must start inside its container, not above it",
    ).toBeGreaterThanOrEqual(railBox.y - 1);
    expect(
      menuBox.y + menuBox.height,
      "the column must end inside its container",
    ).toBeLessThanOrEqual(railBox.y + railBox.height + 1);
  }

  // Reachable AND live: the cog still routes through the shared mutex.
  await page.getByTestId("action-cluster-cog").click();
  await expect(page.locator(".settings-drawer.open")).toBeVisible({ timeout: 5_000 });
});

test("#1040 — a channel window keeps #500's collapsed launcher, floating above it", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // The launcher is back, and the actions are NOT in the DOM until it is tapped
  // — #500 verbatim, on the kind that still has a nick list to protect.
  const launcher = page.getByTestId("rail-actions-launcher");
  await expect(launcher).toBeVisible();
  await expect(page.locator(".rail-actions-menu")).toHaveCount(0);

  await openRailMenu(page);
  const menu = page.locator(".rail-actions-menu");
  await expect(menu).toBeVisible();

  // Still a popover: it opens UPWARD, so it sits above the launcher rather than
  // inside the container's flow. This is the inverse of the containment assert
  // in the first test — the two together say the change is home-only.
  const menuBox = await menu.boundingBox();
  const launcherBox = await launcher.boundingBox();
  expect(menuBox, "the menu must have a layout box").not.toBeNull();
  expect(launcherBox, "the launcher must have a layout box").not.toBeNull();
  if (menuBox && launcherBox) {
    expect(
      menuBox.y + menuBox.height,
      "the collapsed menu must still float above the launcher",
    ).toBeLessThanOrEqual(launcherBox.y + 1);
  }
});

// The mobile arm. Same contract, different mount: the rail is the slide-in
// drawer, so the operator's ONE gesture is opening it — and what they must find
// inside is the buttons, not a launcher charging a second tap. `openRailMenu`
// slides the drawer in and, finding the menu already on screen, taps nothing.
//
// No box comparison here: the drawer is a transformed, animating surface, so a
// containment assert would be measuring the slide as much as the layout. The
// flow-vs-popover shape is pinned on the desktop test above; what is
// form-factor-specific is that the drawer opens straight onto the actions.
test("@webkit @touch #1040 — the mobile rail drawer opens straight onto the actions", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await expect(page.locator(".home-pane")).toBeVisible({ timeout: 15_000 });

  await openRailMenu(page);
  await expect(page.locator(".shell-members.open .rail-actions-menu")).toBeVisible();
  await expect(page.getByTestId("action-cluster-cog")).toBeVisible();
  await expect(page.getByTestId("rail-actions-launcher")).toHaveCount(0);
});
