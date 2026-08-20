// GH #532 — stale unread badges. Two of the four defects have a
// user-visible, browser-observable surface; this spec pins both in a real
// browser (per feedback_ux_e2e_mandatory — vitest can't exercise the live
// WS + REST + cold /me seed + Solid render path the badges depend on).
//
//   A (server) — leaving a channel left a PERMANENT unread. The self-PART
//     persists an own `:part` audit row AFTER the read cursor, and
//     `WindowCounts.snapshot/6` counted it as `events: 1` forever — an
//     archived window the user could neither locate nor clear. The A fix
//     drops the subject's OWN presence rows from the events count, so a
//     self-PART leaves nothing pending. Surface: the archived channel row
//     in the ArchiveModal shows NO event badge.
//
//   B (client) — `ArchiveModal.tsx` rendered kind + target + delete only,
//     so an archived window holding unread was an unattributable number in
//     the aggregate. The B fix renders the SAME badges the sidebar draws,
//     keyed off the SAME server `unread_counts` envelope (`channelKey(slug,
//     normalizeNick(target))`). Surface: an archived DM window holding an
//     unread inbound message shows the message badge.
//
// Why both assert after a page RELOAD: the archive badge must come from the
// server `unread_counts` envelope in the COLD `/me` seed (B's exact ask),
// not from stale live in-memory state. Reloading forces cic to re-seed
// `messagesUnread()` / `eventsUnread()` from the server's
// `build_unread_counts/2` — so test A pins the SERVER-side A fix (own
// presence excluded from the envelope) and test B pins that B reads that
// envelope.
//
// C (own outbound DMs counted) and D (per-casing duplicate cursors) are
// server-internal (the PWA icon badge / cursor-row identity) and are pinned
// by the Elixir unit + migration tests (Push.Triggers/BadgeCount,
// ReadCursor, CollapseNickReadCursors) — they have no distinct browser
// surface, so they are deliberately out of scope here.

import {
  closeArchive,
  expandArchiveGroup,
  loginAs,
  openArchive,
  scrollbackLine,
  selectChannel,
  sidebarCloseButton,
  sidebarWindow,
  waitForDmListenerReady,
} from "../fixtures/cicchettoPage";
import {
  assertMessagePersisted,
  getReadCursor,
  joinChannel,
  partChannel,
  restoreReadCursorToTail,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specLiveNick, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = "i532-peer";
// The nick the server GRANTED, published to afterEach (#944). The cleanup runs
// outside the test body where `peer` is out of scope, and a cursor restore
// aimed at the nick we merely ASKED for would leave the real window's cursor
// behind after a 433 retry.
let grantedPeerNick = PEER_NICK;
const DM_FIRST = "#532 B: first DM — read, so the cursor sits here";
const DM_SECOND = "#532 B: second DM — the unread that the archive badge must show";

test.afterEach(async () => {
  const vjt = specUser();
  // Restore the seed-time joined state (test A parts #spec-wN) and clear the
  // DM unread test B leaves behind, so neither poisons a later spec under
  // retries. Both are idempotent / no-ops for the test that didn't touch
  // them, and guarded so a mid-test failure can't cascade.
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, grantedPeerNick).catch(() => {});
});

test("#532 A — a self-PART leaves NO stale event badge on the archived channel row", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Put the cursor at the current tail so the ONLY row after it is the own
  // PART about to be generated — otherwise unrelated older rows on the
  // shared #bofh would confound the count (same guard r6 uses). The A fix
  // also excludes own presence unconditionally, but pinning the cursor
  // isolates the assertion to exactly the self-PART under test.
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // PART #spec-wN. The self-PART persists an own `:part` audit row (id >
  // cursor) and drops the channel from the active sidebar into Archive.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

  // Reload so the ArchiveModal renders from the COLD `/me` unread envelope
  // (the server's `build_unread_counts/2`), not any live post-PART state —
  // this is what pins the SERVER-side A fix.
  await loginAs(page, vjt);

  await openArchive(page);
  const group = await expandArchiveGroup(page, NETWORK_SLUG);

  // The channel IS archived (present as a row) — proves we reached the
  // right state, so the "no event badge" assertion below is meaningful
  // (not vacuously true because the row is missing).
  await expect(group.locator(".archive-modal-row", { hasText: CHANNEL })).toHaveCount(1, {
    timeout: 5_000,
  });

  // The A assertion: NO event badge on the archived row. Pre-A the own
  // `:part` counted as `events: 1` and this badge rendered "1"; post-A the
  // subject's own presence rows are excluded from the events count, so no
  // event badge appears. Scoping to `.sidebar-events-unread` (not the whole
  // unread wrapper) keeps the assertion robust to a concurrent CONTENT
  // message another spec might land on the shared #bofh — that would add a
  // message badge, never an event badge, and A is strictly about events.
  await expect(
    page.getByTestId(`archive-unread-${NETWORK_SLUG}-${CHANNEL}`).locator(".sidebar-events-unread"),
  ).toHaveCount(0);

  await closeArchive(page);
});

test("#532 B — a closed DM window holding an unread message shows the message badge in Archive", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  // Channel-first focus drives the WS-ready sync the own-nick DM-listener
  // subscribe boots off (mirrors ux-6-k / M4).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await waitForDmListenerReady(page, NETWORK_SLUG);

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  grantedPeerNick = peer.nick;
  try {
    // First inbound DM → cic auto-opens the query window (server-owned,
    // #422). Focus it so the DM renders, then focus away so selection.ts's
    // leave-arm advances the cursor to this first DM — leaving it READ.
    peer.privmsg(await specLiveNick(), DM_FIRST);
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: peer.nick,
      sender: peer.nick,
      body: DM_FIRST,
    });
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(1, { timeout: 5_000 });

    await selectChannel(page, NETWORK_SLUG, peer.nick, { awaitWsReady: false });
    // `.last()` — under `--repeat-each` the DM rows accumulate in the shared
    // backend (afterEach resets the cursor, not the scrollback), so this
    // matches every prior run's copy too; we only need the newest one
    // visible to prove the window loaded before we focus away.
    await expect(scrollbackLine(page, "privmsg", DM_FIRST).last()).toBeVisible({ timeout: 5_000 });
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });

    // Cursor advanced (D's shape-aware fold write path). Poll the server —
    // pre-D the cursor could fork per-casing, but cic sends one spelling so
    // this asserts the DM cursor is set at all before we add the unread.
    await expect
      .poll(() => getReadCursor(vjt.token, NETWORK_SLUG, peer.nick), {
        timeout: 5_000,
        intervals: [100, 200, 500],
      })
      .toBeGreaterThan(0);

    // Second inbound DM while focused elsewhere → exactly ONE unread
    // content row on the peer window.
    peer.privmsg(await specLiveNick(), DM_SECOND);
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: peer.nick,
      sender: peer.nick,
      body: DM_SECOND,
    });

    // Close the DM window: the × pushes `close_query_window`, which DELETES
    // the server `query_windows` row (non-destructive, no confirm modal for
    // query windows) — so on the next cold load the peer is no longer an
    // active window and surfaces in Archive with its unread intact.
    await sidebarCloseButton(page, NETWORK_SLUG, peer.nick).click();
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(0, { timeout: 5_000 });
  } finally {
    await peer.disconnect("#532 B done");
  }

  // Cold reload: the archive badge must come from the server `unread_counts`
  // envelope in `/me`, not stale live state (B's exact ask).
  await loginAs(page, vjt);

  await openArchive(page);
  const group = await expandArchiveGroup(page, NETWORK_SLUG);

  // The peer's closed DM is archived (rows exist, window no longer active).
  await expect(group.locator(".archive-modal-row", { hasText: peer.nick })).toHaveCount(1, {
    timeout: 5_000,
  });

  // The B assertion: the archived DM row shows the MESSAGE badge, sourced
  // from the cold `/me` unread envelope. Pre-B no badge rendered at all;
  // post-B the same `.sidebar-msg-unread` the sidebar draws appears, reading
  // "1" (the single unread second DM; the first was read before close).
  const unread = page.getByTestId(`archive-unread-${NETWORK_SLUG}-${peer.nick}`);
  await expect(unread.locator(".sidebar-msg-unread")).toHaveText("1", { timeout: 5_000 });

  await closeArchive(page);
});
