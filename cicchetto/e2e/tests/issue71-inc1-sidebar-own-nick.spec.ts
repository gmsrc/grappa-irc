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
import { loginAs, sidebarWindow } from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.afterEach(async () => {
  // The rail non-regression test PARTs #bofh to force it into the
  // archive; restore the seed-time joined state so later specs keep
  // working (mirrors archive-desktop-only.spec.ts).
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

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

  // Non-regression, computed-style (real browser only): the per-network
  // grouping rail is a `border-left` on every non-header row of the MAIN
  // per-network <ul>. The ARCHIVE <ul> SHARES the `.sidebar-network-section`
  // class, so the rail rule is scoped `:not(.sidebar-archive-list)`. A unit
  // test asserts the class-string scoping; only getComputedStyle in a real
  // browser proves the archived rows do NOT inherit the rail. Live channel
  // row → 2px rail; archived row → 0px (no rail).
  test("desktop — grouping rail on live rows but NOT archive rows (shared .sidebar-network-section)", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // A LIVE channel row carries the rail. sidebarWindow returns the <li>
    // on desktop; the rail is a border-left on that <li>.
    const liveRow = sidebarWindow(page, NETWORK_SLUG, CHANNEL);
    await expect(liveRow).toHaveCount(1);
    await expect
      .poll(
        async () =>
          await liveRow.evaluate((el) => getComputedStyle(el).borderLeftWidth).catch(() => ""),
        { timeout: 5_000, message: "live channel row should carry the 2px grouping rail" },
      )
      .toBe("2px");

    // PART #bofh so it lands in the archive <ul> (which shares
    // .sidebar-network-section). The archived row MUST NOT inherit the rail.
    await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
    await expect(liveRow).toHaveCount(0, { timeout: 5_000 });

    const networkSection = page.locator(".sidebar-network-section", {
      has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
    });
    const archiveSection = networkSection.locator(
      'xpath=following-sibling::details[@class="sidebar-archive"][1]',
    );
    await archiveSection.locator("summary").click();
    await expect(archiveSection).toHaveAttribute("open", "");

    const archivedRow = archiveSection.locator("li.sidebar-archive-row", { hasText: CHANNEL });
    await expect(archivedRow).toHaveCount(1, { timeout: 5_000 });
    // Poll + re-query: the archive list re-renders on any intervening
    // window-state WS event, and getComputedStyle on a mid-swap detached
    // node resolves to "" (the archive-desktop-only.spec.ts flake).
    await expect
      .poll(
        async () =>
          await archivedRow.evaluate((el) => getComputedStyle(el).borderLeftWidth).catch(() => ""),
        { timeout: 5_000, message: "archived row must NOT inherit the grouping rail" },
      )
      .toBe("0px");
  });
});
