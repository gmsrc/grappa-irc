// UX-5 bucket BK — channel-key JOIN-fail dupe-window fix.
//
// Pre-BK reproduction (vjt dogfood 2026-05-19): /join #keyed-chan
// without the key against a +k channel surfaces TWO windows for the
// same target:
//   1. archive entry — CORRECT (UX-4 bucket H + CP15 B2: failed JOIN
//      persists a :notice scrollback row → archive-eligible).
//   2. sidebar pseudo-row (greyed) — uncloseable (no × button) and
//      duplicates the archive entry. UX dead-end.
//
// BK fix: Sidebar pseudo-rows for failed/kicked/parked/pending all
// get an aria-labeled × button. visibleArchiveForNetwork's filter
// extends to suppress archive entries whose target sits in
// windowStateByChannel — so the failed channel appears in the active
// sidebar pseudo-row only. Click × → setParted drops the windowState
// key → pseudo-row vanishes; archive filter releases → archive entry
// appears. One window, one surface throughout the dismiss cycle.
//
// #473: the archive surface is now the grouped `ArchiveModal` (opened
// from the always-on RailActions button), NOT the retired inline
// Sidebar `<details class="sidebar-archive">`. The dedup contract is
// unchanged — this spec counts each surface independently: the sidebar
// `<li>` pseudo-row vs the modal's `.archive-modal-row`.
//
// Server-side: `apply_effects([{:join_failed, ...}], state)` emits an
// `archive_changed` event on `Topic.user/1` so cic's `archivedBySlug`
// cache refreshes the moment the pseudo-row is dismissed — operator
// sees the archive row land without manually toggling the archive
// section.
//
// Scope: subject-shape-agnostic (the bug is in the dispatch path,
// identical for visitor/nickserv/registered) — one chromium arm
// against the seeded registered vjt is sufficient.
//
// CHANNEL CLEANUP: random per-run suffix; afterEach has the peer PART
// the channel.

import {
  composeSend,
  expandArchiveGroup,
  loginAs,
  openArchive,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const KEYED_CHANNEL = `#ux-5-bk-${crypto.randomUUID().slice(0, 8)}`;
const HAPPY_CHANNEL = `#ux-5-bk-ok-${crypto.randomUUID().slice(0, 8)}`;
const CHANNEL_KEY = "porco-dio";

let peer: IrcPeer | null = null;

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("e2e cleanup").catch(() => {});
    peer = null;
  }
});

test("UX-5 BK — /join +k without key shows ONE pseudo-row (closeable); × dismisses + archive entry surfaces; happy /join still works", async ({
  page,
}) => {
  // Peer creates a +k channel as the founding JOINer (auto-opped on
  // testnet bahamut; see cp15-b6-pending-to-failed-invite-only.spec.ts
  // for the NO_CHANOPS_WHEN_SPLIT rationale).
  peer = await IrcPeer.connect({ nick: `ux5bk-${crypto.randomUUID().slice(0, 6)}` });
  await peer.join(KEYED_CHANNEL);
  await peer.mode(KEYED_CHANNEL, "+k", CHANNEL_KEY);

  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });

  // /join the keyed channel WITHOUT supplying the key → bahamut
  // returns 475 ERR_BADCHANNELKEY → grappa's EventRouter emits
  // {:join_failed, ch, reason, 475} → apply_effects persists the
  // :notice row + flips windowStateByChannel to :failed + broadcasts
  // `kind: "join_failed"` per-channel + `archive_changed` on
  // user-topic.
  await composeSend(page, `/join ${KEYED_CHANNEL}`);

  // The pseudo-row is a plain <li> in the per-network sidebar section.
  // #473 moved the archive OUT of the Sidebar into the grouped
  // ArchiveModal, so a sidebar `li` lookup no longer double-matches an
  // archive row (the pre-#473 `:not(.sidebar-archive-row)` carve-out is
  // gone) — a plain `li` hasText match uniquely resolves the active /
  // pseudo row. BK's "active OR archive, never both" contract is verified
  // by counting each surface independently: this sidebar `<li>` vs the
  // modal's `.archive-modal-row` below.
  const activeRow = page
    .locator(".sidebar-network-section", {
      has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
    })
    .locator("li", { hasText: KEYED_CHANNEL });

  // Wait on the typed `join_failed` arrival: sidebar pseudo-row
  // greyed class is the post-flip sentinel.
  await expect(activeRow.locator(".sidebar-window-greyed")).toBeVisible({ timeout: 10_000 });
  // Exactly ONE row for the failed channel — the pre-BK bug surfaced
  // as a duplicate (channelsBySlug-side + pseudo-row-side). With the
  // BK dedup the channel only ever sits in pseudoChannelsForNetwork
  // until dismissed.
  await expect(activeRow).toHaveCount(1);

  // BK invariant: the row has an aria-labeled × button (pre-BK the
  // pseudo-row was uncloseable; this is the primary fix). Use the
  // ARIA label from the pseudo-row's onClick handler directly.
  const closeBtn = activeRow.getByLabel(`Close ${KEYED_CHANNEL}`);
  await expect(closeBtn).toBeVisible();

  // Archive-view dedup: while the pseudo-row exists, the archive MUST NOT
  // also list the channel. visibleArchiveForNetwork filters anything in
  // windowStateByChannel for the slug. #473 — the archive is the grouped
  // ArchiveModal now; open it and expand the network's group (lazy load),
  // assert the channel is absent, then CLOSE the modal so the pseudo-row's
  // × (behind the overlay) is reachable for the dismiss step.
  {
    const modal = await openArchive(page);
    const group = await expandArchiveGroup(page, NETWORK_SLUG);
    await expect(group.locator(".archive-modal-row", { hasText: KEYED_CHANNEL })).toHaveCount(0);
    await page.getByLabel("close archive").click();
    await expect(modal).toHaveCount(0, { timeout: 5_000 });
  }

  // Click × → setParted drops the windowState key → pseudo-row
  // vanishes from the active sidebar.
  await closeBtn.click();
  await expect(activeRow).toHaveCount(0, { timeout: 5_000 });

  // After dismiss the archive filter releases. The server-side
  // archive_changed broadcast triggered a re-fetch of archivedBySlug; the
  // archive row for KEYED_CHANNEL must now appear in the modal. Re-open +
  // re-expand (the modal unmounts on close, so the lazy load re-fires on
  // this fresh expand), then close it so the happy-path sidebar
  // interactions below aren't behind the overlay.
  {
    const modal = await openArchive(page);
    const group = await expandArchiveGroup(page, NETWORK_SLUG);
    await expect(group.locator(".archive-modal-row", { hasText: KEYED_CHANNEL })).toHaveCount(1, {
      timeout: 10_000,
    });
    await page.getByLabel("close archive").click();
    await expect(modal).toHaveCount(0, { timeout: 5_000 });
  }

  // Negative twin / happy path: a successful /join still produces an
  // active sidebar entry (proves the fix didn't break the success
  // path). Use a fresh channel created by the peer with no +k so the
  // JOIN succeeds. Per feedback_e2e_visitor_members_list, also verify
  // the member list populates post-JOIN.
  await peer.join(HAPPY_CHANNEL);
  await composeSend(page, `/join ${HAPPY_CHANNEL}`);

  // Wait on the WS-truth signal (per-channel self-JOIN scrollback
  // line) — same gate as cp15-b5-window-state-pending-to-joined.
  await expect(
    page
      .locator('[data-testid="scrollback-line"][data-kind="join"]')
      .filter({ hasText: specNick() })
      .filter({ hasText: HAPPY_CHANNEL })
      .first(),
  ).toBeVisible({ timeout: 10_000 });

  const happyRow = page
    .locator(".sidebar-network-section", {
      has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
    })
    .locator("li", { hasText: HAPPY_CHANNEL });
  await expect(happyRow).toHaveCount(1, { timeout: 10_000 });
  // Happy row is NOT greyed (live joined window).
  await expect(happyRow.locator(".sidebar-window-greyed")).toHaveCount(0);

  // Members list invariant (feedback_e2e_visitor_members_list): the
  // member list populates post-JOIN with count > 0 AND own nick visible.
  const membersPane = page.locator(".members-pane");
  await expect(membersPane.locator("li", { hasText: specNick() })).toBeVisible({
    timeout: 10_000,
  });
  await expect(membersPane.locator("li")).not.toHaveCount(0);
});
