// UX-1 (2026-05-17) — Archive delete × + permanent scrollback drop.
//
// Validates the full UX-1 surface in a real browser:
//   1. PART a seeded channel → server emits :parted → channel drops out
//      of the active sidebar list.
//   2. Open the grouped ArchiveModal + expand the network's group →
//      the group lazy-loads → PARTed channel appears as an archive
//      entry with a × delete affordance.
//   3. Click × → InlineConfirmButton arms (label flips to "really
//      delete?").
//   4. Click again → DELETE /networks/:slug/archive/:target fires →
//      server drops the rows + broadcasts `archive_changed` → cic
//      re-fetches archive → the entry disappears.
//   5. Re-JOIN the channel and confirm the scrollback is EMPTY: this is
//      the smoking gun that the rows were actually deleted server-side
//      (vs the row merely vanishing from the cic-side cache).
//
// Per vjt scope decision: BOTH channel-kind AND query-kind get the
// delete affordance. Server-side dispatches by sigil. This spec covers
// the channel-kind path; the query-kind dispatch is covered by the
// controller test on the Elixir side (full cic-side dispatch parity
// is part of the broader cluster journey at UX-Z).
//
// Cleanup: re-JOIN the seeded channel in afterEach (mirror of CP15 B4
// pattern). The archive entry is gone for real — re-joining + sending
// a fresh message in this spec leaves a new row, which the next spec
// will inherit. That's fine; specs already cope with non-empty
// scrollback.

import {
  closeArchive,
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
  // Restore the seed-time joined state so later specs that assume
  // #spec-wN is joined keep working under retries.
  const vjt = specUser();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

test("UX-1 — × on archive entry confirms + deletes scrollback permanently", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Focus the channel first — ensures we're working from healthy
  // state + the join-line lands so we know there IS scrollback to
  // delete in step 5.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1);

  // PART so the channel moves into archive.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

  // Open the grouped ArchiveModal — the ONE archive surface post-#473,
  // replacing the retired desktop Sidebar `<details class="sidebar-archive">`.
  // openArchive taps the always-on rail archive button (mobile-panel-archive)
  // in `.rail-actions`; expandArchiveGroup expands the seeded network's
  // collapsible group, whose `<details onToggle>` lazy-loads its archive
  // rows (loadArchive). Both are viewport-aware page-object helpers so this
  // spec stays layout-agnostic.
  await openArchive(page);
  const group = await expandArchiveGroup(page, NETWORK_SLUG);

  const archivedEntry = group.locator(".archive-modal-row", { hasText: CHANNEL });
  await expect(archivedEntry).toHaveCount(1, { timeout: 5_000 });

  // The delete button is the row's InlineConfirmButton — testId-scoped per
  // (slug, target). Idle label is `×`; armed label is `really delete?`.
  const deleteButton = page.getByTestId(`archive-modal-delete-${NETWORK_SLUG}-${CHANNEL}`);
  await expect(deleteButton).toHaveCount(1);
  await expect(deleteButton).toHaveText("×");

  // First click arms the confirm.
  await deleteButton.click();
  await expect(deleteButton).toHaveText("really delete?", { timeout: 2_000 });

  // Second click confirms → DELETE fires → server broadcasts
  // archive_changed → cic re-fetches archive → the row vanishes from the
  // modal group.
  await deleteButton.click();
  await expect(archivedEntry).toHaveCount(0, { timeout: 5_000 });

  // Close the modal before touching the shell beneath it: the archive
  // modal backdrop is a full-viewport scrim that intercepts pointer
  // events, so the selectChannel below would hang on the backdrop until
  // the test timeout (the pre-#473 Sidebar `<details>` had no backdrop).
  await closeArchive(page);

  // Smoking gun: re-JOIN the channel and confirm scrollback is empty.
  // If the rows were still there, the next selectChannel would render
  // scrollback lines from before the PART.
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1, { timeout: 5_000 });
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // ScrollbackPane carries only the fresh JOIN line; pre-PART rows
  // are gone. Assert no `:message` kind rows remain (privmsg/action/
  // notice — content rows from before). join lines are presence
  // kinds, not message kinds, so they don't count.
  const messageRows = page.locator(".scrollback-line[data-kind='privmsg']");
  await expect(messageRows).toHaveCount(0, { timeout: 3_000 });
});
