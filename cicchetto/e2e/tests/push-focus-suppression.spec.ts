// push-focus-suppression — presence folds window FOCUS, not just Page
// Visibility (#192, 2026-07-06). Regression from #182 (6520956).
//
// #182 keyed foreground push-suppression off `document.visibilityState`
// alone. That stays "visible" for a DESKTOP tab left on-screen but no
// longer holding keyboard focus (user clicked another app without
// minimizing or switching tabs). So a single un-minimized desktop tab
// kept WSPresence's `any_visible?` true and suppressed the ENTIRE per-user
// Web Push fan-out — on every device, a genuinely-backgrounded phone
// included. #192 folds `document.hasFocus()` into the reported presence
// (mirroring documentVisibility.ts) and drives the report off window
// focus/blur too.
//
// This is the sibling of push-foreground-suppression.spec.ts: same
// visible-outcome contract asserted via push-catcher (delivery vs
// no-delivery), but it toggles window FOCUS while `visibilityState`
// stays pinned "visible" — so it exercises exactly the case Page
// Visibility misses. A DM (PRIVMSG to own nick) is the trigger
// (`private_messages_all` defaults true — no channel JOIN needed).
//
//   * visible + FOCUSED → triggering DM → push-catcher receives NOTHING.
//   * visible + BLURRED  → triggering DM → push-catcher DOES receive it.  ← #192
//   * visible + REFOCUSED → triggering DM → push-catcher receives NOTHING.

import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import {
  assertNoPushDelivery,
  awaitPushDelivery,
  enablePushFromSettings,
  expectRfc8291Delivery,
  pushCatcherEndpoint,
  resetPushCatcher,
  resetPushSubscriptions,
  setPageFocus,
  setPageVisibility,
  stubPushManager,
} from "../fixtures/push";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specLiveNick, specNick, specUser, test } from "../fixtures/test";

const PEER_NICK = "focus-suppressor";
const SUB_ID = "focus-suppression";

test("server delivers push once the window is blurred though still on-screen, suppresses again on refocus (#192)", async ({
  page,
  context,
}) => {
  const vjt = specUser();
  await resetPushCatcher();
  await resetPushSubscriptions(vjt.token);
  // Stub MUST install before page.goto (loginAs) — initScripts run for
  // FUTURE navigations only.
  await stubPushManager(context, { endpoint: pushCatcherEndpoint(SUB_ID) });
  await context.grantPermissions(["notifications"]);

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });
  await enablePushFromSettings(page, context, { id: SUB_ID, token: vjt.token });

  // Pin visibilityState "visible" for the whole test so the ONLY variable
  // is window focus — this is the "on-screen but unfocused desktop tab"
  // case #182's visibility-only signal missed.
  await setPageVisibility(page, true);

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Phase 1 — visible AND focused → the server suppresses (baseline,
    // matches #182's visible case). setPageFocus blocks until WSPresence
    // acked present=true, so the DM can't race the focus update.
    await setPageFocus(page, true);
    const focusedBody = "you are looking at the app — no toast please";
    peer.privmsg(await specLiveNick(), focusedBody);
    await assertNoPushDelivery(SUB_ID, {
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      window: peer.nick,
      sender: peer.nick,
      body: focusedBody,
    });

    // Phase 2 — visible but BLURRED (still on-screen, keyboard focus lost).
    // #192: presence is now false → the server MUST deliver. Pre-fix this
    // stayed suppressed because visibilityState alone reported "visible".
    await resetPushCatcher();
    await setPageFocus(page, false);
    const blurredBody = "you clicked another app — deliver this one";
    peer.privmsg(await specLiveNick(), blurredBody);

    const deliveries = await awaitPushDelivery(SUB_ID, {
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      window: peer.nick,
      sender: peer.nick,
      body: blurredBody,
    });
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expectRfc8291Delivery(deliveries[0]);

    // Phase 3 — REFOCUS (still visible) → suppression restored.
    await resetPushCatcher();
    await setPageFocus(page, true);
    const refocusedBody = "back in focus — suppress again";
    peer.privmsg(await specLiveNick(), refocusedBody);
    await assertNoPushDelivery(SUB_ID, {
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      window: peer.nick,
      sender: peer.nick,
      body: refocusedBody,
    });
  } finally {
    await peer.disconnect("#192 focus-suppression done");
  }
});
