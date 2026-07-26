// #71 INC-1 — sidebar hierarchy rework, desktop-visible surface.
//
// Covers the two VISIBLE behaviours a jsdom unit test proves structurally
// but only a real browser confirms rendering against the live GET /networks
// payload:
//   1. The operator's own IRC nick surfaces per-network in the sidebar
//      (issue #71 "Show the user's own nick" — previously shown nowhere).
//      Sourced from the canonical `ownNickForNetwork(net, me)` so the
//      display matches the routing/self-detection nick.
//   2. The network-header row no longer carries the leading ⚙️ that made
//      the server line read reverse-indented against the channels below
//      (issue #71 "server row affordance").
//
// Desktop-only spec (no `@webkit` tag) — the Sidebar IS the desktop chrome;
// the mobile branch renders BottomBar (KEPT per the #71 2nd ruling — the
// drawer/edge-gesture increments were dropped). Runs on the chromium
// project (Desktop Chrome, 1280×720, above the (max-width: 768px) mobile
// breakpoint), same gate as archive-desktop-only.spec.ts.

import { expect, test } from "../fixtures/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

test.describe("#71 INC-1 — sidebar hierarchy", () => {
  test("desktop — own-nick footer surfaces the per-network IRC nick", async ({ page }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // `networks()` is keyed on `user()` (createResource(user, ...)), so by
    // the time loginAs's `.sidebar-network-header` gate passes, `me` is
    // resolved and the footer's `ownNickForNetwork(net, me)` yields the nick.
    const footer = page.getByTestId(`sidebar-own-nick-${NETWORK_SLUG}`);
    await expect(footer).toBeVisible();
    await expect(footer).toContainText(NETWORK_NICK);
  });

  test("desktop — network-header row has no leading ⚙️ (reverse-indent fix)", async ({ page }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    const header = page.locator("li.sidebar-network-header").first();
    await expect(header).toBeVisible();
    // The slug leads the row now; the decorative ⚙️ network-emoji is gone
    // (the 📇 channels row keeps its own emoji — this is scoped to the
    // header <li>).
    await expect(header.locator(".sidebar-network-emoji")).toHaveCount(0);
    await expect(header).toContainText(NETWORK_SLUG);
  });
});
