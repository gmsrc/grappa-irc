// CP15 B4 + B6 — Archive section: PART → archive → click → re-join.
//
// Consolidated 2026-05-26 (spec-audit-ez): the prior cp15-b4 spec was
// a strict subset of this lifecycle (PART → archive → click); the only
// unique signal it carried was the "$server is never archived"
// invariant — folded in at the bottom of this spec. b4 deleted.
//
// Asserts the full archive lifecycle:
//   1. PART a joined channel (#spec-wN, the seeded autojoin) → :parted
//      effect → channel leaves active sidebar + appears in Archive.
//   2. Open the grouped ArchiveModal + expand the network's group →
//      lazy archive REST fetch → entry visible.
//   3. Click archive entry → ScrollbackPane opens for the parted
//      channel (read-only window — TopicBar still shows the name) and
//      the modal closes.
//   4. Type `/join #spec-wN` in compose → state goes pending → joined.
//      Sidebar entry returns to the active section (channelsBySlug
//      branch); the archive entry MUST NOT re-appear in the archive
//      (BUG-A regression guard — the cic-side `visibleArchiveForNetwork`
//      filter mirrors server-side `Scrollback.list_archive/3`'s
//      active_keyset exclusion at render time, so a re-JOINed channel
//      never duplicates between Active + Archive). Re-opening the modal
//      after the re-JOIN shows the row is gone.
//   5. $server-never-archived invariant (folded from b4): even with the
//      network archive group open + populated, no "$server" entry
//      appears there — `Scrollback.list_archive/3` filters $server out
//      regardless of active_keyset.
//
// Cleanup: re-JOIN (assertion path itself) leaves #spec-wN in the
// joined state, matching the seed → no afterEach restoration needed.
// The PART side-effect on autojoin survives across runs otherwise.

import {
  composeSend,
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
  // Defensive restore — if the re-join assertion failed, #spec-wN would
  // be left parted and subsequent specs that assume the seed state
  // (M1, BUG7) would fail.
  const vjt = specUser();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
});

test("CP15 B6 — PART → archive → re-join: row moves from active to archive and back; archive list dedup holds", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1);

  // PART via REST. server emits :parted → cic drops the channel from
  // channelsBySlug + windowState (own-PART projects to absence per
  // subscribe.ts), so the active sidebar row vanishes.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

  // Open the grouped ArchiveModal + expand the network's group. The
  // group's `<details onToggle>` lazy-loads its archive rows (loadArchive
  // fires on the open transition), exactly like the retired Sidebar
  // `<details class="sidebar-archive">`. archivedBySlug populates → the
  // parted channel appears as a clickable entry. openArchive/
  // expandArchiveGroup are viewport-aware page-object helpers so the spec
  // stays layout-agnostic.
  await openArchive(page);
  const group = await expandArchiveGroup(page, NETWORK_SLUG);
  const archivedEntry = group.locator(".archive-modal-row", { hasText: CHANNEL });
  await expect(archivedEntry).toHaveCount(1, { timeout: 5_000 });

  // Click the archive entry → setSelectedChannel opens the parted channel
  // (read-only window) and closes the modal. TopicBar still carries the
  // channel name as the read-only window's header.
  await archivedEntry.locator(".archive-modal-entry-btn").click();
  await expect(page.locator(".archive-modal")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator(".topic-bar")).toContainText(CHANNEL, { timeout: 5_000 });

  // Re-JOIN via /join in compose. setPending fires synchronously +
  // setSelectedChannel re-focuses; once the upstream JOIN echo lands,
  // channels_changed broadcasts → channelsBySlug refetches → the
  // channel returns to the active section AND the archive list's
  // render-time filter (visibleArchiveForNetwork) drops the entry
  // since it's now in channelsBySlug.
  await composeSend(page, `/join ${CHANNEL}`);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1, { timeout: 5_000 });

  // Final state sanity: members snapshot lands → MembersPane shows the
  // joined branch with vjt-grappa as @ founder. Asserted BEFORE re-opening
  // the modal so its backdrop doesn't cover the rail's members pane.
  const membersPane = page.locator(".members-pane");
  await expect(membersPane.locator("li", { hasText: specNick() })).toBeVisible({
    timeout: 5_000,
  });

  // BUG-A regression guard: a re-JOINed channel MUST NOT appear in the
  // archive. The cic-side visibleArchiveForNetwork render-time filter
  // (e3934b0) mirrors server-side Scrollback.list_archive/3's active_keyset
  // exclusion, so the channel never duplicates between Active + Archive.
  // The entry-click above closed the modal, so re-open it + re-expand the
  // group; the row is gone even though its archive rows still exist
  // server-side.
  await openArchive(page);
  const regroup = await expandArchiveGroup(page, NETWORK_SLUG);
  await expect(regroup.locator(".archive-modal-row", { hasText: CHANNEL })).toHaveCount(0, {
    timeout: 5_000,
  });

  // $server-never-archived invariant (folded from cp15-b4 2026-05-26):
  // the archive group MUST NOT contain a "$server" entry, regardless of
  // active_keyset state — Scrollback.list_archive/3 filters $server out
  // unconditionally. Pin the rule here so a future regression in that
  // filter surfaces in e2e too. Verify with a POPULATED group: re-PART
  // #spec-wN with the modal still open — the archive_changed broadcast
  // reactively refreshes the already-expanded group (loadArchive re-fires),
  // so #spec-wN reappears WITHOUT re-expanding, while $server never does.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });
  await expect(regroup.locator(".archive-modal-row", { hasText: CHANNEL })).toHaveCount(1, {
    timeout: 5_000,
  });
  await expect(regroup.locator(".archive-modal-row", { hasText: "$server" })).toHaveCount(0);

  // Restore seed state for downstream specs.
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});
