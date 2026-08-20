// Desktop archive surface — real-browser-only guarantees (#473 rework).
//
// #473 folded the three pre-existing archive openers (the desktop Sidebar
// `<details class="sidebar-archive">`, the mobile `.mobile-panel-actions`
// footer chip, and the mobile-only ShellChrome `shell-chrome-archive` 📂
// button) into ONE grouped `ArchiveModal`, opened by the always-on
// `mobile-panel-archive` button in the permanent RailActions rail. This spec
// captures the two behaviours a jsdom unit test proves only structurally but a
// real browser confirms against the live layout:
//
//   1. The rail archive button is present on desktop across EVERY window kind
//      and, when tapped, opens the grouped modal (the desktop archive door
//      exists and is wired — pre-#473 the ShellChrome button was mobile-only
//      and there was no universal desktop opener; now the rail is permanent so
//      the button is reachable everywhere).
//   2. An archived row's entry `<button>` resolves `font-family` to the
//      canonical monospace stack (`--font-mono`). The pre-#473 regression this
//      guarded (a Sidebar archive `<ul>` missing the canonical row-style class,
//      so rows fell back to the UA-default serif) now lives on
//      `.archive-modal-entry-btn`; only getComputedStyle in a real browser
//      confirms the resolved stack.
//
// Desktop-only spec (no `@webkit` tag) — runs on the chromium project, which
// uses `devices["Desktop Chrome"]` (1280×720 viewport, well above the
// (max-width: 768px) mobile breakpoint).

import {
  expandArchiveGroup,
  loginAs,
  openArchive,
  openRailMenu,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.afterEach(async () => {
  // Restore the seed-time joined state so later specs keep working.
  const vjt = specUser();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

test("desktop — rail archive button is present across every window kind and opens the grouped modal", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // The archive button is an always-on rail action (NOT selection-gated), so
  // it must be reachable on every selection kind a desktop user can land on:
  // home (post-login default), then a channel, and the server tab (the kind
  // that, pre-#473, surfaced the retired mobile ShellChrome button — proving
  // the rail button is universal, not selection-shape dependent). Query is
  // covered transitively (same always-on rail).
  // #500 — the archive button lives behind the RailActions launcher menu, in
  // the DOM only after the launcher is tapped. openRailMenu reveals the menu
  // (idempotent, viewport-aware) so the always-available archive affordance is
  // reachable on every window kind; re-scope to `.rail-actions-menu` where it
  // now renders.
  const archiveBtn = page.locator(".rail-actions-menu [data-testid='mobile-panel-archive']");

  // Home selection (post-login).
  await openRailMenu(page);
  await expect(archiveBtn).toBeVisible();

  // Channel selection.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1);
  await openRailMenu(page);
  await expect(archiveBtn).toBeVisible();

  // Server tab selection.
  const serverTab = sidebarWindow(page, NETWORK_SLUG, "Server");
  await serverTab.click();
  await openRailMenu(page);
  await expect(archiveBtn).toBeVisible();

  // Positive proof the button is wired to the grouped modal (not merely
  // present): tapping it opens the ArchiveModal dialog with its title.
  const modal = await openArchive(page);
  await expect(modal).toBeVisible();
  await expect(modal.locator("#archive-modal-title")).toHaveText("Archive");
});

test("desktop — archive modal rows inherit the canonical monospace style", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Real-browser-only proof: an archived row's entry `<button>` resolves
  // `font-family` to the monospace stack via `.archive-modal-entry-btn`
  // (`font-family: var(--font-mono)`). Pre-#473 the equivalent Sidebar archive
  // `<ul>` was missing the canonical row-style gating class, so rows resolved
  // to the UA default (system serif). A unit test asserts the JSX class
  // string; here we read the live built DOM's computed value.

  // PART so a channel lands in the archive (the fixture seed leaves #spec-wN
  // joined; partChannel's server-side broadcast moves it into the archive).
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

  // Open the grouped modal and expand this network's group (triggers the lazy
  // row load).
  await openArchive(page);
  const group = await expandArchiveGroup(page, NETWORK_SLUG);

  const archivedRow = group.locator(".archive-modal-row", { hasText: CHANNEL });
  await expect(archivedRow).toHaveCount(1, { timeout: 5_000 });
  const archivedBtn = archivedRow.locator(".archive-modal-entry-btn");
  await expect(archivedBtn).toHaveCount(1, { timeout: 5_000 });

  // Computed font-family on the archived row's button matches the canonical
  // monospace stack. The modal list re-renders on any window-state /
  // archive_changed WS event (an intervening spec's JOIN/PART broadcast),
  // replacing the button node. A one-shot `.evaluate(getComputedStyle)` can
  // grab the node mid-swap — after it detaches, `getComputedStyle` on a
  // disconnected element resolves `fontFamily` to "" (the flake). Poll +
  // re-query each tick so a transient detach is retried; the contract asserted
  // (monospace stack) is unchanged.
  await expect
    .poll(
      async () =>
        (
          await archivedBtn.evaluate((el) => getComputedStyle(el).fontFamily).catch(() => "")
        ).toLowerCase(),
      { timeout: 5_000, message: "archive row font-family should resolve to monospace" },
    )
    .toMatch(/mono/);
});
