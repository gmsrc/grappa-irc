// CP15 B6 — archived query revival.
//
// Asserts the DM (query) lifecycle through the archive:
//   1. `/q <peer>` opens a query window on vjt's sidebar; no
//      scrollback row exists yet, but the window is in
//      queryWindowsByNetwork.
//   2. Vjt sends "hello-archive" → the PRIVMSG persists server-side
//      with dm_with = peer, so the archive query (run later) finds
//      a row keyed on peer's nick.
//   3. Vjt clicks × on the query window → closeQueryWindowState fires
//      → the window leaves queryWindowsByNetwork.
//   4. Open the grouped ArchiveModal + expand the network's group →
//      lazy loadArchive fetches the per-network list → the peer entry
//      shows up as a group row (kind: "query").
//   5. Click the archived entry → REVIVE. Under #473 a query-kind row
//      calls openQueryWindowState (re-subscribing cic to the peer's
//      per-channel topic) AND setSelectedChannel, then closes the modal.
//      The DM window becomes LIVE again (re-enters queryWindowsByNetwork
//      + subscribed) — the click IS the revive (the pre-#473 "navigate
//      to history, revive only on a following /msg" two-step is gone).
//   6. visibleArchiveForNetwork's render-time filter drops the peer from
//      the archive the moment it re-enters queryWindowsByNetwork
//      (active/archive boundary restored) — re-opening the modal shows
//      the peer row is gone.
//
// Peer setup: a single IrcPeer instance stays connected for the
// duration so vjt's PRIVMSGs land on a real upstream nick that
// bahamut routes back as a notice / privmsg-echo (and the dm_with
// row persists server-side regardless of peer activity — the row
// is created at PRIVMSG send-time on the bouncer's IRC client).
//
// CHANNEL CLEANUP: PEER_NICK is randomised per run, so the revived query
// window (left open by step 5's revive) can't collide with any other
// spec — afterEach only disconnects the upstream peer, which cleans the
// upstream nick. No explicit window close needed.

import {
  composeSend,
  expandArchiveGroup,
  loginAs,
  openArchive,
  selectChannel,
  waitForDmListenerReady,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = `cp15b6q-${crypto.randomUUID().slice(0, 6)}`;

let peer: IrcPeer | null = null;

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("e2e cleanup").catch(() => {});
    peer = null;
  }
});

test("CP15 B6 — /msg peer + close → archive entry; clicking the archive row revives the query + drops the archive entry", async ({
  page,
}) => {
  // Peer must be online so the upstream PRIVMSG target exists
  // (bahamut would emit 401 ERR_NOSUCHNICK otherwise; the bouncer
  // would still persist the outbound row, but the e2e flow stays
  // closer to a normal user interaction with a live target).
  peer = await IrcPeer.connect({ nick: PEER_NICK });

  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });
  // Barrier against the documented DM-listener race (see
  // waitForDmListenerReady): `selectChannel` awaits the channel topic
  // join, NOT the own-nick topic join. Firing `/msg` before the own-nick
  // subscribe completes means the outbound PRIVMSG broadcast fans out to
  // zero subscribers → the query window never opens and the row never
  // renders ("no messages yet"). This is what actually flaked cp15-b6 in
  // the full suite (row absent even at 15s), not slow timing — the 7
  // sibling DM specs (m4/m5/m6/cp14-b3/ux-6-k/ux-6-l/p0b) already guard
  // this; cp15-b6 was the lone omission.
  await waitForDmListenerReady(page, NETWORK_SLUG);

  // /msg opens the query window, focuses it, and sends the PRIVMSG
  // in one compose interaction. The PRIVMSG persists with dm_with =
  // peer so the archive query (run later) finds the entry.
  //
  // UX-5 BH (2026-05-19): `.sidebar-network` renamed to
  // `.sidebar-network-section`; legacy `<h3>` per-network header
  // dropped in UX-4 bucket C — `.sidebar-network-header` is the
  // post-C row. Use the post-BH selectors.
  // Round-trip assertions below use a 15s budget, not Playwright's 5s
  // default. The /msg → bouncer-persist → WS-push → scrollback-render
  // (and the archive REST queries) round-trip can exceed 5s under
  // full-suite load on a slow host — observed 7.5s on the Raspberry Pi
  // dev box, where this spec flaked while passing 3/3 in isolation and
  // with the entire chromium prefix (bisected: timing, not state). 15s
  // removes the flake without masking a genuine hang. See DESIGN_NOTES
  // 2026-06-09 "cp15-b6 / m6 e2e timing flake".
  await composeSend(page, `/msg ${PEER_NICK} hello-archive`);
  const queryRow = page
    .locator(".sidebar-network-section", {
      has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
    })
    .locator("li", { hasText: PEER_NICK });
  await expect(queryRow).toHaveCount(1, { timeout: 15_000 });

  // Confirm the row landed server-side via REST before closing — the
  // close fire-and-forgets a WS push and the archive REST race that
  // ate the prior version of this spec was the underlying cause:
  // closing before the row is durable means active_keyset still
  // includes peer when archive REST fires.
  await expect(
    page.locator('[data-testid="scrollback-line"][data-kind="privmsg"]').filter({
      hasText: "hello-archive",
    }),
  ).toBeVisible({ timeout: 15_000 });

  // Close × — closeQueryWindowState drops the window from
  // queryWindowsByNetwork. The cic-side row vanishes immediately;
  // server-side close_query_window event is fired so a reload would
  // see the same state.
  await queryRow.locator(".sidebar-close").click();
  await expect(queryRow).toHaveCount(0, { timeout: 15_000 });

  // Open the grouped ArchiveModal + expand the network's group. The
  // group's `<details onToggle>` lazily fires loadArchive; the per-network
  // archive query returns the peer entry (has a scrollback row, not in the
  // active query set). openArchive/expandArchiveGroup are viewport-aware
  // page-object helpers replacing the retired Sidebar
  // `<details class="sidebar-archive">`.
  await openArchive(page);
  const group = await expandArchiveGroup(page, NETWORK_SLUG);
  const archivedEntry = group.locator(".archive-modal-row", { hasText: PEER_NICK });
  await expect(archivedEntry).toHaveCount(1, { timeout: 15_000 });

  // Click the archived query entry → REVIVE. Under #473 a query-kind row
  // calls openQueryWindowState (re-subscribing cic to the peer's
  // per-channel topic) AND setSelectedChannel, then closes the modal —
  // the click IS the revive (the pre-#473 "view history, revive only on a
  // following /msg" two-step is gone).
  await archivedEntry.locator(".archive-modal-entry-btn").click();

  // Modal closes on select.
  await expect(page.locator(".archive-modal")).toHaveCount(0, { timeout: 5_000 });

  // Revival outcome 1 — the active query row reappears in the sidebar
  // (the window re-entered queryWindowsByNetwork).
  await expect(queryRow).toHaveCount(1, { timeout: 15_000 });

  // Revival outcome 2 — the window is LIVE again, i.e. cic re-subscribed
  // to the peer's per-channel topic (openQueryWindowState → server
  // query_window_opened → subscribe loop joins → __cic_queryWindowReady
  // stamped). Without the subscribe, server NOTICEs (e.g. a 401 for this
  // peer) would drop on the floor and the operator would see no feedback.
  await waitForQueryWindowReady(page, NETWORK_SLUG, PEER_NICK);

  // Archive dedup guard: a revived query MUST NOT still appear in the
  // archive. visibleArchiveForNetwork's render-time filter excludes the
  // peer the moment it re-enters queryWindowsByNetwork (and list_archive's
  // active_keyset excludes it server-side too). The select above closed
  // the modal, so re-open it + re-expand the group; the peer row is gone.
  await openArchive(page);
  const regroup = await expandArchiveGroup(page, NETWORK_SLUG);
  await expect(regroup.locator(".archive-modal-row", { hasText: PEER_NICK })).toHaveCount(0, {
    timeout: 15_000,
  });
});
