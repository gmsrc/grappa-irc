// @webkit — #71 INC-3. The /invite-opened `:invited` virtual channel is
// ADDED to the mobile BottomBar. Post-vjt-reversal scope: the BottomBar
// STAYS (drawer/gesture cancelled); the only gap was that the `:invited`
// window the desktop Sidebar already renders was missing from the mobile
// bar. The bar surfaces ONLY the `:invited` slice of the shared pseudo-row
// projection (lib/pseudoChannels.ts) — an INTENTIONAL narrowing vs the
// Sidebar, which renders EVERY non-joined state (pending/failed/kicked/
// parked). The bottom bar is space-scarce; failed/kicked/parked are
// history best confined to the sidebar. See DESIGN_NOTES 2026-07-26.
//
// This spec asserts BOTH sides of that narrowing on a REAL mobile viewport
// (vjt ruling condition b — without the negative assert the narrowing is
// untested and drifts on the first change):
//   (a) an invited channel APPEARS in the BottomBar (data-window-state
//       pins it to the real `:invited` derivation);
//   (b) a channel whose JOIN FAILED does NOT appear — even though its
//       `:failed` state genuinely materialized (compose-box greyed), so
//       the exclusion is real, not a not-yet-rendered race.
//
// BottomBar is mobile-only (Shell renders it only in the isMobile()
// branch), so this runs on the webkit-iphone-15 project alone — the
// @webkit tag; the chromium project grepInverts it.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

// Per-run-unique names — bahamut holds a ghosted nick + lingering channel
// state for a window after disconnect, so literals collide on rapid
// reruns (feedback: static peer NICKs must be per-run-unique).
const INVITED_CHANNEL = `#inc3-inv-${crypto.randomUUID().slice(0, 8)}`;
const FAILED_CHANNEL = `#inc3-fail-${crypto.randomUUID().slice(0, 8)}`;

let peer: IrcPeer | null = null;

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("inc3 cleanup").catch(() => {});
    peer = null;
  }
});

test("@webkit #71 INC-3 — the /invite virtual channel appears in the mobile BottomBar; a failed JOIN does NOT", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  peer = await IrcPeer.connect({ nick: `inc3peer-${crypto.randomUUID().slice(0, 6)}` });

  // (1) INVITED side. Bahamut requires the inviter to be on the channel it
  // invites to (else 442 ERR_NOTONCHANNEL), so the peer joins first. #78
  // routes the inbound INVITE to a not-joined `:invited` window state.
  await peer.join(INVITED_CHANNEL);
  peer.rawInvite(NETWORK_NICK, INVITED_CHANNEL);

  // (2) FAILED side. The peer founds a `+i` (invite-only) channel; the
  // operator's /join is rejected (473 ERR_INVITEONLYCHAN) → the channel
  // flips to `:failed`. `.compose-box-greyed` is the "state machine
  // flipped to failed" sentinel (mirrors cp15-b6): asserting it BEFORE the
  // negative BottomBar check makes the exclusion a genuine narrowing, not
  // a race against a not-yet-rendered row.
  await peer.join(FAILED_CHANNEL);
  await peer.mode(FAILED_CHANNEL, "+i");
  await composeSend(page, `/join ${FAILED_CHANNEL}`);
  await expect(page.locator(".compose-box")).toHaveClass(/compose-box-greyed/, { timeout: 10_000 });

  // sidebarWindow() is mobile-aware: on webkit it resolves to the
  // `.bottom-bar-tab[data-window-name=...]` button inside the network
  // section — i.e. the BottomBar tab, not a desktop sidebar row.

  // (a) the invited channel APPEARS. data-window-state pins the row to the
  //     real `:invited` derivation (server do_route(:invite) → window_invited
  //     → cic setInvited → shared projection → BottomBar `:invited` filter);
  //     a break anywhere in that chain goes RED here rather than riding the
  //     generic greyed treatment to a false green.
  const invitedTab = sidebarWindow(page, NETWORK_SLUG, INVITED_CHANNEL);
  await expect(invitedTab).toBeVisible({ timeout: 10_000 });
  await expect(invitedTab).toHaveAttribute("data-window-state", "invited");

  // (b) the failed channel does NOT appear — the intentional narrowing.
  //     Its `:failed` state exists (compose greyed above), yet the bottom
  //     bar renders only `:invited`.
  await expect(sidebarWindow(page, NETWORK_SLUG, FAILED_CHANNEL)).toHaveCount(0);

  // (c) the × on the invited tab dismisses it AND lands focus on the
  //     network $server window — the UNIFIED cross-surface behavior
  //     (dismissPseudoWindow, shared with the desktop Sidebar ×). The
  //     redirect only fires when the dismissed row is the FOCUSED window,
  //     so select it first. Asserting the $server landing (not merely that
  //     the tab vanished) is what pins the unified navigation on mobile.
  await invitedTab.tap();
  await page.getByRole("button", { name: `Close ${INVITED_CHANNEL}` }).tap();
  await expect(sidebarWindow(page, NETWORK_SLUG, INVITED_CHANNEL)).toHaveCount(0);
  // sidebarWindow maps "Server" (or the slug) → the $server network-header;
  // passing the literal "$server" would fall into the channel-tab branch and
  // match nothing. After the redirect the mobile network-header is selected.
  await expect(sidebarWindow(page, NETWORK_SLUG, "Server")).toHaveClass(/selected/, {
    timeout: 5_000,
  });

  // Cleanup: drop both windows from the operator's state (idempotent; the
  // helper swallows 404 if a window never persisted).
  await partChannel(vjt.token, NETWORK_SLUG, INVITED_CHANNEL).catch(() => {});
  await partChannel(vjt.token, NETWORK_SLUG, FAILED_CHANNEL).catch(() => {});
});
