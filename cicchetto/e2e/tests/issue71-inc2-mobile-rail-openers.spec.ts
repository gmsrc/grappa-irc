// #71 INC-2 — mobile rail openers (Opt A, the 3 paletti). The right rail is a
// PERMANENT surface reachable on EVERY mobile window through ONE drawer, opened
// by ONE ☰ glyph from both window kinds:
//   * channel window     → TopicBar hamburger (aria-label "open members sidebar")
//   * non-channel window  → ShellChrome rail opener (`shell-chrome-rail-opener`,
//                           which REPLACED the old settings cog)
// The settings cog lives ONLY in the rail's ActionCluster now, so reaching
// settings on a non-channel mobile window is a two-tap door (open rail → cog) —
// accepted for a low-frequency action, and no door disappears.
//
// Paletti asserted here:
//   1. ONE drawer/rail for both paths — both openers toggle the SAME
//      `.shell-members` drawer that hosts the ActionCluster cog.
//   2. IDENTICAL ☰ glyph (U+2630) in both openers.
//   3. Settings reachable on a NON-channel MOBILE window.
//
// @webkit / iPhone 15 — the drawer + openers are mobile-only (desktop has the
// always-visible permanent rail; see issue71-inc2-permanent-rail-desktop).

import { loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const OPENER_GLYPH = "\u{2630}"; // ☰ — identical glyph in both openers (paletto 2)

test.setTimeout(60_000);

test.describe("#71 INC-2 — mobile rail openers (Opt A)", () => {
  test("@webkit @touch non-channel (home): ☰ rail opener → drawer → cog opens settings", async ({
    page,
  }) => {
    const vjt = specUser();
    await loginAs(page, vjt);

    // Cold-load lands on home (non-channel). ShellChrome renders the ☰ RAIL
    // OPENER — not a cog (the cog moved into the rail it opens).
    const railOpener = page.getByTestId("shell-chrome-rail-opener");
    await expect(railOpener).toBeVisible({ timeout: 10_000 });
    await expect(railOpener).toHaveText(OPENER_GLYPH); // paletto 2 — identical ☰
    // The old chrome cog is gone from this bar.
    await expect(page.locator("[data-testid='shell-chrome-cog']")).toHaveCount(0);

    // Tap it → the SAME `.shell-members` drawer opens (paletto 1), hosting the
    // ActionCluster cog behind the RailActions launcher (#500).
    await railOpener.tap();
    const drawer = page.locator(".shell-members.open");
    await expect(drawer).toBeVisible({ timeout: 5_000 });
    await openRailMenu(page);
    const cog = drawer.locator(".rail-actions-menu [data-testid='action-cluster-cog']");
    await expect(cog).toBeVisible();

    // Tap the cog → members drawer closes (mutex) + settings drawer opens.
    // Settings IS reachable on a non-channel mobile window (paletto 3).
    await cog.tap();
    await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator(".settings-drawer.open")).toBeVisible({ timeout: 5_000 });
  });

  test("@webkit @touch channel: TopicBar ☰ opens the SAME drawer + cog (ONE drawer, ONE glyph)", async ({
    page,
  }) => {
    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    // Channel windows render the TopicBar hamburger, NOT the ShellChrome rail
    // opener (no standalone chrome row on mobile-channel). Same ☰ glyph.
    await expect(page.locator(".shell-chrome")).toHaveCount(0);
    const topicHamburger = page.getByLabel(/open members sidebar/i);
    await expect(topicHamburger).toBeVisible({ timeout: 10_000 });
    await expect(topicHamburger).toHaveText(OPENER_GLYPH); // paletto 2 — identical ☰

    // Tap it → the SAME `.shell-members` drawer (paletto 1), hosting the cog
    // behind the RailActions launcher (#500) — proving both openers converge on
    // one drawer + one cog home.
    await topicHamburger.tap();
    const drawer = page.locator(".shell-members.open");
    await expect(drawer).toBeVisible({ timeout: 5_000 });
    await openRailMenu(page);
    await expect(
      drawer.locator(".rail-actions-menu [data-testid='action-cluster-cog']"),
    ).toBeVisible();
  });
});
