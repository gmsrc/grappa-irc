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
// This spec is the MIRROR of issue482-invite-survives-reload: same
// INVITE + reload witness, OPPOSITE verdict.
//
// TWO invites, only ONE dismissed — the KEPT invite is a condition-based
// co-witness (code-review finding, #511). Both `window_invited` events ride
// the SAME ordered user-topic cold-snapshot burst
// (`push_session_snapshot` → `WindowState.invited_windows/2`), a DIFFERENT
// cold-load cycle from the REST `/channels` chain that repaints the autojoin
// tab. So waiting for the KEPT tab to reappear proves that very snapshot
// burst was dispatched + processed — the exact burst that WOULD carry the
// dismissed tab's resurrection if the server still held it. That makes the
// dismissed tab's absence DETERMINISTIC, with no magic `waitForTimeout`
// slack: post-fix the server dropped the dismissed key so it is not in the
// burst at all; pre-fix it was, and rode the burst back to life.
//
// The positive LIVE assertions (both tabs visible + `data-window-state`)
// use the SAME `sidebarWindow` locator as the negative post-reload check —
// the anti-vacuity guard proving the selector matches when a tab IS present.
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
const DISMISSED_CHANNEL = `#inv511d-${crypto.randomUUID().slice(0, 8)}`;
const KEPT_CHANNEL = `#inv511k-${crypto.randomUUID().slice(0, 8)}`;

test("#511 — a dismissed inbound INVITE's greyed :invited tab does NOT return after a reload, while a non-dismissed sibling does (server-side PART, not a client-only drop)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Confirm login on a real channel first (self-JOIN echo present) so the
  // upstream session is live before the INVITEs.
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Bahamut requires the inviter to be on the channel it invites to (else
    // 442 ERR_NOTONCHANNEL), so the peer joins both first, then relays the
    // two raw INVITEs to the operator's session.
    await peer.join(DISMISSED_CHANNEL);
    await peer.join(KEPT_CHANNEL);
    peer.rawInvite(NETWORK_NICK, DISMISSED_CHANNEL);
    peer.rawInvite(NETWORK_NICK, KEPT_CHANNEL);

    // LIVE (anti-vacuity guard): both greyed :invited tabs appear. Asserting
    // `data-window-state` pins them to the real :invited derivation (not the
    // generic greyed class shared by every not-joined pseudo-row) and proves
    // the `sidebarWindow` selector matches when a tab IS present.
    const dismissedTab = sidebarWindow(page, NETWORK_SLUG, DISMISSED_CHANNEL);
    const keptTab = sidebarWindow(page, NETWORK_SLUG, KEPT_CHANNEL);
    await expect(dismissedTab).toBeVisible({ timeout: 10_000 });
    await expect(dismissedTab).toHaveAttribute("data-window-state", "invited");
    await expect(keptTab).toBeVisible({ timeout: 10_000 });
    await expect(keptTab).toHaveAttribute("data-window-state", "invited");

    // Dismiss ONLY the first, via its × (aria-label `Close <#channel>`, the
    // stable seam the desktop Sidebar + mobile BottomBar share). This routes
    // through `dismissPseudoWindow` → the #511 `partAndForget` DELETE. The
    // row vanishes locally immediately (`forceParted`); the KEPT tab is
    // untouched.
    await dismissedTab.getByLabel(`Close ${DISMISSED_CHANNEL}`).click();
    await expect(dismissedTab).toHaveCount(0, { timeout: 5_000 });
    await expect(keptTab).toBeVisible();

    // RELOAD — tears down the WS + cic's in-memory `windowStateByChannel`;
    // the upstream `Session.Server` survives. Pre-fix it STILL held the
    // dismissed channel at :invited, so the #482 cold-snapshot backfill
    // re-emitted its `window_invited` and the tab returned. Post-fix the
    // DELETE's PART cleared the server key, so the backfill has nothing to
    // re-assert for it — but still holds the KEPT channel.
    await page.reload();
    await expectShellReady(page);

    // BARRIER (condition-based co-witness): the KEPT invite reappears from
    // the SAME user-topic cold-snapshot burst the dismissed one would ride
    // if the server still held it. Its visibility proves the burst was
    // dispatched + processed, so the dismissed tab's absence below is
    // deterministic — not a race against a slower snapshot.
    const keptTabAfter = sidebarWindow(page, NETWORK_SLUG, KEPT_CHANNEL);
    await expect(keptTabAfter).toBeVisible({ timeout: 15_000 });
    await expect(keptTabAfter).toHaveAttribute("data-window-state", "invited");

    // HEADLINE (RED pre-fix — the dismissed tab resurrected on reload): with
    // the co-witness burst proven processed, the dismissed :invited tab is
    // definitively gone.
    await expect(sidebarWindow(page, NETWORK_SLUG, DISMISSED_CHANNEL)).toHaveCount(0);
  } finally {
    // Best-effort: the fix already parted the dismissed window server-side,
    // but the KEPT one is still :invited — clear BOTH so they can't pollute
    // sibling specs' cold-loads (per the #482 cleanup rationale).
    await partChannel(vjt.token, NETWORK_SLUG, DISMISSED_CHANNEL).catch(() => {});
    await partChannel(vjt.token, NETWORK_SLUG, KEPT_CHANNEL).catch(() => {});
    await peer.disconnect("511 done");
  }
});
