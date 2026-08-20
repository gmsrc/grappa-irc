// UX-2 (2026-05-17; #473 rework) — MOBILE archive surface via the rail.
//
// Pre-#473 this opened the archive through the ShellChrome
// `[data-testid="shell-chrome-archive"]` button, which resolved the
// network from the currently-selected window and opened a single-network
// modal. #473 DELETED that button (along with the desktop Sidebar
// `<details class="sidebar-archive">` and the mobile
// `.mobile-panel-actions` chip): the ONE archive surface is now the
// grouped `ArchiveModal`, opened by the always-on `mobile-panel-archive`
// button in the RailActions rail (`.rail-actions` inside
// `.shell-members`). On mobile the rail is a collapsed drawer, so
// `openArchive` opens the rail then taps archive (viewport-aware). The
// modal renders EVERY network as a collapsible group — no per-network
// resolution — and each group lazy-loads its rows on expand. Confirm
// flow still re-uses UX-1's `deleteArchiveEntry` + `InlineConfirmButton`.
//
// Flow under test (mobile):
//   1. PART seed channel → :parted → channel moves out of channelsBySlug.
//   2. openArchive → rail drawer opens → mobile-panel-archive taps →
//      ArchiveModal opens (plain "Archive" header, all networks grouped).
//   3. Expand the seeded network's group → PARTed channel is listed.
//   4. Tap × → InlineConfirmButton arms ("really delete?").
//   5. Tap again → DELETE fires → server broadcasts `archive_changed` →
//      cic re-fetches → entry vanishes from the modal group.
//   6. Close modal (× in header) → modal closed.
//
// Cleanup: re-JOIN the channel in afterEach so later specs see #spec-wN
// joined (mirror of UX-1 / iOS-3 pattern).
//
// Per-class parity matrix per `feedback_e2e_user_class_parity_matrix`:
// UX-2 is a UI shape bucket — not an IRC-function spec. The visitor
// path here exercises the rail → ArchiveModal end-to-end on mobile. The
// full visitor/nickserv/registered loop runs in the UX-4-Z composed
// journey.

import {
  expandArchiveGroup,
  loginAs,
  openArchive,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.afterEach(async () => {
  const vjt = specUser();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

test("@webkit UX-2 — rail archive opens the grouped modal + delete drops entry", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Focus the channel so we know it's live + scrollback fanned out.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible({ timeout: 10_000 });

  // PART so the channel moves into archive. After PART the cic selection
  // redirect (bucket E close-watcher) moves focus away from the closed
  // channel — but the rail archive button is ALWAYS shown post-#473 (not
  // selection-gated), so no server-tab dance is needed to surface it.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).not.toBeVisible({ timeout: 10_000 });

  // openArchive (mobile) opens the rail drawer then taps
  // mobile-panel-archive → the grouped ArchiveModal. The header is
  // network-agnostic now: plain "Archive", NOT "Archive — <slug>"
  // (repurposed from the retired per-network header assertion — that
  // string carried the network the old single-network modal resolved).
  const modal = await openArchive(page);
  await expect(modal.locator("#archive-modal-title")).toHaveText("Archive");

  // Expand the seeded network's group → lazy-loads its rows → the PARTed
  // channel is listed.
  const group = await expandArchiveGroup(page, NETWORK_SLUG);
  const row = group.locator(".archive-modal-row", { hasText: CHANNEL });
  await expect(row).toHaveCount(1);

  // Delete button — UX-1's InlineConfirmButton, test-id scoped per
  // (slug, target). Idle label "×"; armed label "really delete?".
  const deleteBtn = page.getByTestId(`archive-modal-delete-${NETWORK_SLUG}-${CHANNEL}`);
  await expect(deleteBtn).toHaveText("×");
  await deleteBtn.tap();
  await expect(deleteBtn).toHaveText("really delete?", { timeout: 2_000 });

  // Second tap → server DELETE → archive_changed broadcast → cic
  // re-fetches → row disappears from the modal group.
  await deleteBtn.tap();
  await expect(row).toHaveCount(0, { timeout: 5_000 });

  // Modal close × clears the modal-open signal.
  await modal.getByLabel("close archive").tap();
  await expect(modal).not.toBeVisible({ timeout: 3_000 });
});
