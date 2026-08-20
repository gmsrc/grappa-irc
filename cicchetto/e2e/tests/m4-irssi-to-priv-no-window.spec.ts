// M4 — peer PRIVMSG to vjt's nick when cicchetto has NO query window open
// for that peer. Expected:
//   - DM persists server-side at channel = specNick() (the inbound
//     DM target — grappa stores using the recipient nick as channel)
//   - cicchetto auto-opens a query window keyed on the SENDER nick
//     (subscribe.ts DM-listener loop calls openQueryWindowState then
//     re-keys the append from own-nick to sender — see subscribe.ts
//     "C4.1 / DM live-WS gap" comment)
//   - msg-unread badge on the auto-opened window shows "1" (cicchetto is
//     focused on #spec-wN, not the new DM window)
//   - clicking the DM window: scrollback renders the body AND the
//     badge clears (selection.ts isSelected gate)
//
// The auto-open code path is DIFFERENT from M6's outbound /msg:
//   - M6: compose.ts /msg handler explicitly calls openQueryWindowState
//   - M4: subscribe.ts DM-listener handler does it on inbound PRIVMSG
// Both end up in the same client-state store but the trigger paths
// are independent — M4 specifically pins the inbound side.
//
// Assertion order matters: badge MUST be checked BEFORE the click-
// to-inspect, otherwise the focus-switch clears the badge mid-test.

import {
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarMessageBadge,
  sidebarWindow,
  waitForDmListenerReady,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specLiveNick, specNick, specUser, test } from "../fixtures/test";

const PEER_NICK = "m4-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const MESSAGE_BODY = "M4: inbound DM to nick";

test("M4 — inbound DM auto-opens query window with unread, clears on focus", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  // Stay focused on #spec-wN — the DM lands in a NEW window we're NOT
  // looking at, so unread MUST bump. selectChannel here also doubles
  // as the WS-ready sync (own-nick subscribe.ts join for the dm-
  // listener topic happens off the same effect chain).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await waitForDmListenerReady(page, NETWORK_SLUG);

  // Connect BEFORE the pre-condition so every locator below is keyed on the
  // nick the server GRANTED, not the one we asked for (#944). A connected-
  // but-idle peer opens no query window, so the pre-condition observes the
  // same state it did when it ran above the connect.
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Pre-condition: no query window for the peer yet (fresh stack
    // guarantees it; assert anyway so a future cross-test contamination
    // surfaces here loudly instead of as a confusing "1 already there
    // before peer sent" flake).
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(0);

    peer.privmsg(await specLiveNick(), MESSAGE_BODY);

    // Server-side: row persisted at channel = specNick() (the
    // RECIPIENT nick is the channel for inbound DMs) with sender =
    // PEER_NICK + dm_with = PEER_NICK (CP14-B3 derivation). We probe
    // via REST against channel = PEER_NICK because the OR-shape DM
    // aggregation (channel == peer OR dm_with == peer) matches the
    // inbound row, which is the same lookup cic uses when the user
    // opens the auto-spawned PEER_NICK query window. Probing channel
    // = specNick() would hit the own-nick narrowing path
    // (channel == own AND dm_with == own — self-msgs only) and miss
    // peer-originated DMs.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: peer.nick,
      sender: peer.nick,
      body: MESSAGE_BODY,
    });

    // Sidebar gains exactly one entry for the sender nick.
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(1, { timeout: 5_000 });

    // Unread badge "1" — cicchetto still on #spec-wN, query window is
    // unfocused by definition. Asserted BEFORE the click-to-inspect
    // because clicking would clear it (selection.ts isSelected gate).
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, peer.nick)).toHaveText("1", {
      timeout: 5_000,
    });

    // Focus the DM window: scrollback shows the body, badge clears.
    await selectChannel(page, NETWORK_SLUG, peer.nick, { awaitWsReady: false });
    await expect(scrollbackLine(page, "privmsg", MESSAGE_BODY)).toBeVisible({ timeout: 5_000 });
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, peer.nick)).toHaveCount(0);
  } finally {
    await peer.disconnect("M4 done");
  }
});
