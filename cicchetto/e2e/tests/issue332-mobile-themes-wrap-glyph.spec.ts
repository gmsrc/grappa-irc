// #332 → #473 — the themes launcher in the RailActions drawer.
//
// HISTORY: #332 restored the 🎨 themes launcher under the members sidebar
// as one of several buttons in a HORIZONTAL, mobile-only `.mobile-panel-actions`
// footer that `flex-wrap`ped narrow buttons down to glyph-only when the row
// ran out of width. #473 retired that footer entirely: every rail affordance
// now lives in `.rail-actions`, a VERTICAL, full-width, single-column list
// (`flex-direction: column`) mounted at the bottom of `.shell-members` on BOTH
// desktop and mobile and on EVERY window kind. Each row shows its glyph AND a
// text label side by side; the list never wraps, so a button never collapses
// to glyph-only.
//
// The old "wrap to glyph" premise is therefore DEAD — the rail cannot wrap and
// the themes button always shows its "themes" label. This spec is repurposed to
// pin the NEW reality of the themes launcher in the rail:
//
//   1. The themes launcher DEEP-LINKS: tap it → members drawer closes (mutex) →
//      settings drawer opens directly on the THEMES gallery sub-page (not the
//      flat main index). Exercises openThemesPanel's settingsNav hand-off.
//   2. The themes launcher is a FULL-WIDTH row (the #473 shape that superseded
//      the wrap-to-glyph footer): the rail is a `flex-direction: column` list,
//      and the themes row shows BOTH its 🎨 glyph and its "themes" text label
//      with neither clipped, spanning the rail width — never a narrow glyph
//      button.
//   3. The settings cog renders the ⚙️ emoji (U+2699 U+FE0F), not the bare ⚙
//      (U+2699) glyph that rendered too small (#332 item 3). #71 INC-2 moved
//      the cog into the rail's ActionCluster; #473 folded that into RailActions,
//      so the emoji contract now rides the `action-cluster-cog` row's icon span.
//      jsdom can't render emoji presentation, so this browser e2e is the only
//      guard for the glyph choice (the RailActions unit test asserts the label,
//      not the exact icon codepoint).
//
// The rail is present on both form factors, but this spec stays @webkit /
// iPhone-15: the drawer-open flow (tap hamburger → drawer slides in) is the
// mobile path, and it exercises the touch chain a real iOS user produces.

import {
  loginAs,
  openMembersDrawer,
  openRailMenu,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const SETTINGS_COG_EMOJI = "\u{2699}\u{FE0F}"; // ⚙️ — the emoji-presentation cog (#332 item 3)
const THEMES_GLYPH = "\u{1F3A8}"; // 🎨 — the themes launcher glyph

test.setTimeout(60_000);

test.describe("#332/#473 — rail themes launcher: full-width labelled row + deep-link + ⚙️ cog emoji", () => {
  test("@webkit @touch themes launcher deep-links to the themes gallery sub-page", async ({
    page,
  }) => {
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    await openMembersDrawer(page);
    // #500 — the themes launcher is collapsed behind the rail launcher; reveal
    // the menu first (openRailMenu sees the drawer is open and taps the
    // launcher). The button lives inside `.rail-actions-menu` now.
    await openRailMenu(page);
    const menu = page.locator(".shell-members.open .rail-actions-menu");
    const themesBtn = menu.locator("[data-testid='mobile-panel-themes']");
    await expect(themesBtn).toBeVisible();

    // Tap themes → members drawer closes (mutex) AND the settings drawer
    // opens straight on the themes gallery (deep-link), NOT the main page.
    await themesBtn.tap();
    await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator(".settings-drawer.open")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("theme-gallery")).toBeVisible({ timeout: 5_000 });
  });

  test("@webkit @touch themes launcher is a full-width row showing both its glyph and 'themes' label", async ({
    page,
  }) => {
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    await openMembersDrawer(page);
    const rail = page.locator(".shell-members.open .rail-actions");
    await expect(rail).toBeVisible();

    // #500 — the labelled button list is collapsed behind the launcher; reveal
    // the menu (openRailMenu sees the drawer is open and taps the launcher).
    await openRailMenu(page);
    const menu = page.locator(".shell-members.open .rail-actions-menu");
    await expect(menu).toBeVisible();

    // #473 → #500 CSS contract: the rail's action list is a VERTICAL
    // single-column list that never wraps (superseding the horizontal
    // `.mobile-panel-actions` flex-wrap footer that clipped buttons to
    // glyph-only). #500 moved that list from `.rail-actions` into the overlay
    // `.rail-actions-menu`, which carries the `flex-direction: column` now — so
    // assert on the menu. This is the direct replacement for the retired
    // `flex-wrap: wrap` assertion.
    const flexDirection = await menu.evaluate((el) => getComputedStyle(el).flexDirection);
    expect(flexDirection).toBe("column");

    // The themes launcher shows BOTH its 🎨 glyph and its "themes" text label —
    // no wrap-to-glyph, no clipped label.
    const themesBtn = menu.locator("[data-testid='mobile-panel-themes']");
    await expect(themesBtn).toBeVisible();
    const themesIcon = themesBtn.locator(".rail-action-icon");
    const themesLabel = themesBtn.locator(".rail-action-label");
    await expect(themesIcon).toHaveText(THEMES_GLYPH);
    await expect(themesLabel).toHaveText("themes");
    // Both parts must stay within the viewport (never clipped off-screen — the
    // failure mode #299 fixed by removal and #473 by the full-width column).
    await expect(themesIcon).toBeInViewport();
    await expect(themesLabel).toBeInViewport();

    // Full-width row (not a narrow glyph button): the button spans essentially
    // the whole rail width (only the rail's own padding shaves the edges).
    const railBox = await rail.boundingBox();
    const btnBox = await themesBtn.boundingBox();
    if (railBox === null || btnBox === null) throw new Error("rail/themes button has no box");
    expect(btnBox.width).toBeGreaterThanOrEqual(railBox.width * 0.8);
  });

  test("@webkit @touch settings cog renders the ⚙️ emoji, not the bare ⚙ glyph", async ({
    page,
  }) => {
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    await openMembersDrawer(page);
    // #500 — the cog is collapsed behind the rail launcher; reveal the menu
    // (openRailMenu sees the drawer is open and taps the launcher).
    await openRailMenu(page);
    // #71 INC-2 + #473 — the settings cog lives in the rail's RailActions
    // drawer; its label row now carries a "settings" text label next to the
    // glyph, so scope the emoji assertion to the icon span (the button's full
    // text is "⚙️settings"). The ⚙️ emoji-presentation contract rides the icon.
    // #500 — the cog now lives inside `.rail-actions-menu`; scope to it.
    const cogIcon = page.locator(
      ".shell-members.open .rail-actions-menu [data-testid='action-cluster-cog'] .rail-action-icon",
    );
    await expect(cogIcon).toHaveText(SETTINGS_COG_EMOJI);
  });
});
