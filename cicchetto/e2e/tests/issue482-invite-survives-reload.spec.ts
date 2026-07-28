// #482 — an inbound INVITE must leave a DURABLE trace: the greyed
// `:invited` tab has to survive a cold WS re-subscribe (reload /
// backgrounded PWA / reconnect), and the restored `$server` copy carries
// the `[Join now]` CTA. vjt's live symptom: *"non appare il canale nella
// bottom bar […] e non appare manco niente nella status window"* — the tab
// evaporated on reload because `:invited` was broadcast on the user topic
// ONCE, at INVITE time, and was absent from the cold-subscribe snapshot.
//
// The fix (#482): `push_user_snapshot` now backfills `window_invited` for
// every `:invited` window (mirroring the #229 umode cold-snapshot), and
// EventRouter persists a second `$server` copy of the INVITE row so the
// status window keeps a snapshot-independent record with the CTA. BOTH
// rows are `:server_event` (event-tier, NEITHER content nor notify) so the
// unread badge is NOT doubled.
//
// The witness is the #229 pattern applied to INVITE — designed so ONLY the
// cold-snapshot backfill can satisfy it:
//   1. a peer INVITEs the operator to a channel it is not in → the greyed
//      `:invited` tab appears LIVE (event-time broadcast, socket subscribed);
//   2. the page RELOADS — the WS + cic's in-memory `windowStateByChannel`
//      are torn down; the upstream `Session.Server` survives, still holding
//      `#target` at `:invited`. There is NO live INVITE echo in the reloaded
//      session, so the ONLY path that can repopulate the greyed tab is the
//      user-topic after-join cold-snapshot. Pre-fix: the tab is gone → RED.
//      Post-fix: the tab is back, still `:invited` → GREEN;
//   3. selecting the restored tab renders the persisted INVITE row + the
//      `[Join now]` CTA — the durable trace #482 restores.
//
// Needs the live upstream + a session surviving a browser reload, which
// jsdom/vitest cannot do (per feedback_cicchetto_browser_smoke).

import { expect, test } from "../fixtures/test";
import {
  expectShellReady,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

// Per-run-unique — bahamut lingers channel/nick state after disconnect, so
// static literals collide on rapid reruns (feedback: per-run-unique names).
const PEER_NICK = `inv482-${crypto.randomUUID().slice(0, 6)}`;
const TARGET_CHANNEL = `#inv482-${crypto.randomUUID().slice(0, 8)}`;

test("#482 — inbound INVITE's greyed :invited tab survives a reload (cold-snapshot backfill) + the [Join now] CTA is restored", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Confirm login on a real channel first (self-JOIN echo present) so the
  // upstream session is live before the INVITE.
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Bahamut requires the inviter to be on the channel it invites to (else
    // 442 ERR_NOTONCHANNEL), so the peer joins first, then relays the raw
    // INVITE to the operator's session.
    await peer.join(TARGET_CHANNEL);
    peer.rawInvite(NETWORK_NICK, TARGET_CHANNEL);

    // LIVE: the greyed :invited tab appears (event-time window_invited on
    // the user topic; the socket is subscribed, so this arm is the baseline,
    // not the #482 witness). data-window-state pins it to the real :invited
    // derivation, not the generic greyed class shared by every not-joined
    // pseudo-row.
    const invitedTab = sidebarWindow(page, NETWORK_SLUG, TARGET_CHANNEL);
    await expect(invitedTab).toBeVisible({ timeout: 10_000 });
    await expect(invitedTab).toHaveAttribute("data-window-state", "invited");

    // RELOAD — tears down the WS + windowStateByChannel; the upstream
    // Session.Server survives holding #target at :invited. There is no live
    // INVITE echo in the reloaded session, so the ONLY path that can bring
    // the greyed tab back is the user-topic after-join cold-snapshot. This
    // is the P0 witness (#482).
    await page.reload();
    await expectShellReady(page);

    // HEADLINE (RED pre-fix — the tab evaporated on reload): the greyed
    // :invited tab is back from the cold-snapshot, WITHOUT any INVITE in the
    // reloaded session.
    const invitedTabAfter = sidebarWindow(page, NETWORK_SLUG, TARGET_CHANNEL);
    await expect(invitedTabAfter).toBeVisible({ timeout: 15_000 });
    await expect(invitedTabAfter).toHaveAttribute("data-window-state", "invited");
    await expect(invitedTabAfter.locator(".sidebar-window-greyed")).toBeVisible();

    // Selecting the restored tab renders the persisted INVITE row + the
    // [Join now] CTA — the durable trace #482 restores (the row survived the
    // reload in scrollback; the CTA keys off the row, not its window).
    await selectChannel(page, NETWORK_SLUG, TARGET_CHANNEL, { awaitWsReady: false });
    const joinBtn = page.locator(".scrollback-invite-join").first();
    await expect(joinBtn).toBeVisible({ timeout: 10_000 });
    await expect(joinBtn).toContainText(/join/i);

    const row = page
      .locator('[data-testid="scrollback-line"]')
      .filter({ hasText: PEER_NICK })
      .filter({ hasText: TARGET_CHANNEL })
      .first();
    await expect(row).toBeVisible();
  } finally {
    // Cleanup: #482 makes :invited windows survive-on-reload, so a lingering
    // one would now pollute sibling specs' cold-loads (pre-#482 they
    // evaporated). Join → part fully clears the server-side window_state;
    // the peer must still be connected for bahamut to relay the JOIN. Both
    // steps are best-effort (idempotent if the test bailed early).
    try {
      await selectChannel(page, NETWORK_SLUG, TARGET_CHANNEL, { awaitWsReady: false });
      const joinBtn = page.locator(".scrollback-invite-join").first();
      if (await joinBtn.isVisible().catch(() => false)) {
        await joinBtn.click();
        await expect(sidebarWindow(page, NETWORK_SLUG, TARGET_CHANNEL)).toHaveClass(/selected/, {
          timeout: 10_000,
        });
      }
    } catch {
      // ignore — fall through to the API part + peer teardown
    }
    await partChannel(vjt.token, NETWORK_SLUG, TARGET_CHANNEL).catch(() => {});
    await peer.disconnect("482 done");
  }
});
