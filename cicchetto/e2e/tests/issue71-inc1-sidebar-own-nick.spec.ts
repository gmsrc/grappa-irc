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

import { expandArchiveGroup, loginAs, openArchive, sidebarWindow } from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.afterEach(async () => {
  // The rail non-regression test PARTs #spec-wN to force it into the
  // archive; restore the seed-time joined state so later specs keep
  // working (mirrors archive-desktop-only.spec.ts).
  const vjt = specUser();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

test.describe("#71 INC-1 — sidebar hierarchy", () => {
  test("desktop — own-nick footer surfaces the per-network IRC nick", async ({ page }) => {
    const vjt = specUser();
    await loginAs(page, vjt);

    // `networks()` is keyed on `user()` (createResource(user, ...)), so by
    // the time loginAs's `.sidebar-network-header` gate passes, `me` is
    // resolved and the footer's `ownNickForNetwork(net, me)` yields the nick.
    const footer = page.getByTestId(`sidebar-own-nick-${NETWORK_SLUG}`);
    await expect(footer).toBeVisible();
    await expect(footer).toContainText(specNick());
  });

  test("desktop — network-header row has no leading ⚙️ (reverse-indent fix)", async ({ page }) => {
    const vjt = specUser();
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
  // per-network <ul>. A live channel row → 2px rail. #473 moved the archive OUT
  // of the Sidebar into the grouped ArchiveModal, so the archive <ul> no longer
  // shares `.sidebar-network-section` (the old rail rule needed a
  // `:not(.sidebar-archive-list)` carve-out — both are gone); a parted channel
  // now LEAVES the <ul> for the modal, where it stays reachable. A unit test
  // asserts the class-string scoping; only getComputedStyle in a real browser
  // proves the live row carries the rail.
  test("desktop — grouping rail on live sidebar rows; parted channel moves to the archive modal", async ({
    page,
  }) => {
    const vjt = specUser();
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

    // PART #spec-wN → it leaves the main network <ul> (no longer a sidebar row)
    // and lands in the archive, which is now the grouped ArchiveModal (#473),
    // NOT a sidebar `<details>`.
    await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
    await expect(liveRow).toHaveCount(0, { timeout: 5_000 });

    // Reachable in the modal: open it and expand this network's group (triggers
    // the lazy row load).
    await openArchive(page);
    const group = await expandArchiveGroup(page, NETWORK_SLUG);
    const archivedRow = group.locator(".archive-modal-row", { hasText: CHANNEL });
    await expect(archivedRow).toHaveCount(1, { timeout: 5_000 });
  });
});
