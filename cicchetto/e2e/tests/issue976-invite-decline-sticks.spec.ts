// #976 — the invite banner's × is a DECLINE, and a declined invite STAYS
// declined. This file was `issue902-invite-banner-dismiss-ephemeral.spec.ts`
// and asserted the exact opposite; before that it was
// `issue511-invited-dismiss-durable.spec.ts` and asserted this. The renames
// are the honest record of a contract that has been deliberately reversed
// twice, not of tests being tidied.
//
// #511's subject was the greyed `:invited` pseudo-row, whose dismissal had to
// be durable: a client-only drop let #482's cold-subscribe backfill re-emit
// `window_invited` and the dismissed TAB came back. #902 replaced the row with
// a banner and ruled its × session-scoped — "an invite is allowed to be lost",
// the peer can invite again — so the return was reclassified from bug to
// intent.
//
// #976 reverses that, because the escape hatch it rested on did not exist. A
// channel left `:invited` only by being JOINed: no verb dropped the state,
// nothing expired it, so the invite was re-asserted at the top of the page on
// every reload until the operator gave in. The reporter's words: "una volta
// chiuso con la x non dovresti più riproporlo ... sennò è cazzo stalking". An
// offer you cannot refuse is not an offer.
//
// So what this guards is the REVERSAL, and each half earns its assertion:
//
//   * the DECLINED invite does not return after a reload — the difference
//     between a decline and #902's hide, invisible to any unit test because
//     the client-local behaviour is identical either way and only the SERVER
//     key differs;
//   * the KEPT invite does return — the decline must not have been a blanket
//     clear, and (see below) it doubles as the barrier;
//   * a SECOND DEVICE loses the declined banner without touching it. The
//     `:invited` state is per-session and reaches clients by broadcast, so a
//     decline that did not fan out would leave device B showing an invite the
//     server no longer holds, and re-showing it on B's next reload — the
//     original complaint with one extra step.
//
// TWO invites, only ONE declined — the KEPT one is the condition-based
// co-witness inherited from #511. Both `window_invited` events ride the SAME
// ordered user-topic cold-snapshot burst (`push_session_snapshot` →
// `WindowState.invited_windows/2`), a DIFFERENT cold-load cycle from the REST
// `/channels` chain that repaints the autojoin tab. Waiting for the KEPT
// banner proves that burst was dispatched + processed, so the verdict on the
// DECLINED one is read at a proven-settled moment rather than raced against a
// slower snapshot. Without it, "it did not come back" would be a statement
// about timing, not about the server key.
//
// Needs the live upstream + a session surviving a browser reload, which
// jsdom/vitest cannot do (per feedback_cicchetto_browser_smoke).

import {
  expectShellReady,
  inviteBanner,
  inviteBannerDismiss,
  loginAs,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

// Per-run-unique — bahamut lingers channel/nick state after disconnect, so
// static literals collide on rapid reruns (feedback: per-run-unique names).
const PEER_NICK = `inv976-${crypto.randomUUID().slice(0, 6)}`;
const DECLINED_CHANNEL = `#inv976d-${crypto.randomUUID().slice(0, 8)}`;
const KEPT_CHANNEL = `#inv976k-${crypto.randomUUID().slice(0, 8)}`;

test("#976 — declining an invite drops it on every device and it does NOT come back after a reload", async ({
  page,
  browser,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Confirm login on a real channel first (self-JOIN echo present) so the
  // upstream session is live before the INVITEs.
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  // DEVICE B — the same operator, a second browser context, so a second WS on
  // the same user topic. Opened BEFORE the invites: its own banners appearing
  // is what proves it is subscribed, without reaching for a private readiness
  // flag.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await loginAs(pageB, vjt);
  await expectShellReady(pageB);

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Bahamut requires the inviter to be on the channel it invites to (else
    // 442 ERR_NOTONCHANNEL), so the peer joins both first, then relays the
    // two raw INVITEs to the operator's session.
    await peer.join(DECLINED_CHANNEL);
    await peer.join(KEPT_CHANNEL);
    peer.rawInvite(specNick(), DECLINED_CHANNEL);
    peer.rawInvite(specNick(), KEPT_CHANNEL);

    // LIVE on A: TWO banners, stacked. This is the only place in the suite
    // where a single banner SOURCE has more than one live entry — the case
    // that forced the registry's dismiss identity to widen from source to
    // entry.
    const declined = inviteBanner(page, NETWORK_SLUG, DECLINED_CHANNEL);
    const kept = inviteBanner(page, NETWORK_SLUG, KEPT_CHANNEL);
    await expect(declined).toBeVisible({ timeout: 10_000 });
    await expect(kept).toBeVisible({ timeout: 10_000 });

    // LIVE on B: the same two, from the same broadcast. Also the barrier for
    // the fan-out verdict below — B is proven to be receiving user-topic
    // events, so a banner LEAVING it later is a fact about the decline rather
    // than about a socket that was never up.
    const declinedB = inviteBanner(pageB, NETWORK_SLUG, DECLINED_CHANNEL);
    const keptB = inviteBanner(pageB, NETWORK_SLUG, KEPT_CHANNEL);
    await expect(declinedB).toBeVisible({ timeout: 10_000 });
    await expect(keptB).toBeVisible({ timeout: 10_000 });

    // Decline ONLY the first, on device A.
    await inviteBannerDismiss(page, NETWORK_SLUG, DECLINED_CHANNEL).click();

    // A loses it — and note WHY: nothing is hidden client-side, the banner
    // goes when the server's `window_invite_declined` drops the window. The
    // kept banner staying up is the same per-entry proof #902 took here, on a
    // real stack of sibling elements.
    await expect(declined).toHaveCount(0, { timeout: 10_000 });
    await expect(kept).toBeVisible();

    // THE FAN-OUT: B loses it too, without anyone touching B. Red if the
    // decline ever becomes a local drop plus a REST call whose result is not
    // broadcast — a shape that looks correct on the acting device and leaves
    // every other one stale.
    await expect(declinedB).toHaveCount(0, { timeout: 10_000 });
    await expect(keptB).toBeVisible();

    // RELOAD A — tears down the WS and cic's in-memory `windowStateByChannel`;
    // the upstream `Session.Server` survives, and re-emits `window_invited`
    // for whatever it still holds at `:invited`.
    await page.reload();
    await expectShellReady(page);

    // BARRIER (condition-based co-witness): the KEPT invite reappears from the
    // user-topic cold-snapshot burst. Its visibility proves the burst was
    // dispatched + processed, so the verdict below is read at a settled
    // moment.
    await expect(inviteBanner(page, NETWORK_SLUG, KEPT_CHANNEL)).toBeVisible({ timeout: 15_000 });

    // HEADLINE: the declined invite is GONE. This is the #976 fix and the
    // reversal of #902 — red the moment the × goes back to being a hide, or
    // the server verb stops clearing `states` / `invited_by`.
    await expect(inviteBanner(page, NETWORK_SLUG, DECLINED_CHANNEL)).toHaveCount(0);
  } finally {
    // KEPT is still `:invited` server-side, so it MUST be cleared or it
    // pollutes sibling specs' cold-loads (the #482 cleanup rationale).
    // DECLINED is already gone; the PART is a harmless no-op that keeps the
    // cleanup symmetric rather than dependent on the assertions having run.
    await partChannel(vjt.token, NETWORK_SLUG, KEPT_CHANNEL).catch(() => {});
    await partChannel(vjt.token, NETWORK_SLUG, DECLINED_CHANNEL).catch(() => {});
    await ctxB.close().catch(() => {});
    await peer.disconnect("976 done");
  }
});
