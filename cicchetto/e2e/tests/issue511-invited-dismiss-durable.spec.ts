// #511 — dismissing an :invited pseudo-row with its × must be DURABLE:
// the greyed tab stays gone across a page reload. Pre-fix the × was
// client-only (`forceParted`), the upstream `Session.Server` kept
// `window_states[ch] = :invited`, and #482's cold-subscribe backfill
// (`WindowState.invited_windows/2`) re-emitted `window_invited` on the next
// reload — the dismissed tab came back. The fix routes the × through the
// SAME DELETE (`postPart`) `closeChannelWindow` uses: the upstream PART is a
// 442 no-op for the never-joined channel, but `PartCleanup.cleanup_local`
// → `WindowState.set_parted` drops the server key so the backfill has
// nothing left to re-assert. The dismissal now mutates server state.
//
// This spec is the exact MIRROR of issue482-invite-survives-reload: same
// setup + reload witness, OPPOSITE verdict. The positive LIVE assertion
// (tab visible + `data-window-state=invited`, via the SAME `sidebarWindow`
// locator used in the negative check) BEFORE the dismiss is the
// anti-vacuity guard — it proves the selector AND the invite path landed,
// so the post-reload absence check is a real witness, not an empty green.
//
// RED pre-fix: after reload the tab returns via the #482 backfill (exactly
// what issue482 asserts is DESIRABLE for a NON-dismissed invite) → the
// `toHaveCount(0)` fails. GREEN post-fix: the server key is gone → no
// backfill → the tab stays dismissed.
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
const PEER_NICK = `inv511-${crypto.randomUUID().slice(0, 6)}`;
const TARGET_CHANNEL = `#inv511-${crypto.randomUUID().slice(0, 8)}`;

test("#511 — a dismissed inbound INVITE's greyed :invited tab does NOT return after a reload (server-side PART, not a client-only drop)", async ({
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

    // LIVE (anti-vacuity guard): the greyed :invited tab appears. Asserting
    // `data-window-state` pins it to the real :invited derivation (not the
    // generic greyed class shared by every not-joined pseudo-row) and proves
    // the `sidebarWindow` selector matches when the tab IS present — so the
    // post-reload `toHaveCount(0)` below is a meaningful absence check.
    const invitedTab = sidebarWindow(page, NETWORK_SLUG, TARGET_CHANNEL);
    await expect(invitedTab).toBeVisible({ timeout: 10_000 });
    await expect(invitedTab).toHaveAttribute("data-window-state", "invited");

    // Dismiss via the pseudo-row's × (aria-label `Close <#channel>`, the
    // stable seam the desktop Sidebar + mobile BottomBar share). This routes
    // through `dismissPseudoWindow` → the #511 `partAndForget` DELETE. The
    // row vanishes locally immediately (`forceParted`).
    await invitedTab.getByLabel(`Close ${TARGET_CHANNEL}`).click();
    await expect(invitedTab).toHaveCount(0, { timeout: 5_000 });

    // RELOAD — tears down the WS + cic's in-memory `windowStateByChannel`;
    // the upstream `Session.Server` survives. Pre-fix it STILL held #target
    // at :invited, so the #482 cold-snapshot backfill re-emitted
    // `window_invited` and the tab returned. Post-fix the DELETE's PART
    // cleared the server key, so the backfill has nothing to re-assert.
    await page.reload();
    await expectShellReady(page);

    // Barrier: wait for the cold subscribe to actually LAND — the real
    // autojoin channel's tab coming back proves a full REST + WS re-subscribe
    // cycle completed (the same cycle that would carry the #482 invited
    // backfill). Without this, an immediate `toHaveCount(0)` would pass
    // trivially against nothing-rendered-yet, even pre-fix.
    await expect(sidebarWindow(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0])).toBeVisible({
      timeout: 15_000,
    });

    // HEADLINE (RED pre-fix — the dismissed tab resurrected on reload): the
    // greyed :invited tab STAYS gone. The #482 backfill fires inside the
    // after-join user-topic snapshot (sub-second, already past by the time
    // the autojoin tab above rendered); this bounded settle covers any
    // user-topic-vs-REST ordering slack so a resurrected tab would have
    // appeared before we assert its absence.
    await page.waitForTimeout(2_000);
    await expect(sidebarWindow(page, NETWORK_SLUG, TARGET_CHANNEL)).toHaveCount(0);
  } finally {
    // Best-effort: the fix already parted the window server-side, so nothing
    // should linger — but if the test bailed before the dismiss (or on a
    // pre-fix RED run the tab is back at :invited), clear it so it can't
    // pollute sibling specs' cold-loads (per the #482 cleanup rationale).
    await partChannel(vjt.token, NETWORK_SLUG, TARGET_CHANNEL).catch(() => {});
    await peer.disconnect("511 done");
  }
});
