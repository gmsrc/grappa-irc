// push-foreground-suppression — server-side foreground push-suppression
// (#182, 2026-07-05).
//
// THE headline feature test. Reworked from the former
// `push-server-fires-regardless-of-focus.spec.ts`, which asserted the
// OLD contract ("server fires regardless of focus"). That contract is
// now REVERSED: when any of the subject's devices reports the PWA is
// on-screen, the server suppresses the ENTIRE Web Push fan-out at
// source — because the SW's `clients.matchAll` visibility is unreliable
// on iOS PWAs (the root cause of #182). The page reports its real
// foreground state via `document.visibilitychange` (reliable on iOS)
// → WSPresence → the Push.Triggers gate.
//
// We assert the VISIBLE OUTCOME via push-catcher (delivery vs
// no-delivery), not internal calls:
//   * device VISIBLE  → triggering DM → push-catcher receives NOTHING.
//   * device HIDDEN    → triggering DM → push-catcher DOES receive it.
//
// A DM (PRIVMSG to own nick) is used as the trigger because
// `private_messages_all` defaults true — no channel JOIN needed, and
// the server-side gate is independent of which window is selected.
//
// The SW's client-side `shouldSuppressPush` re-check is RETAINED as a
// defensive backstop and is unit-tested in `pushDedup.test.ts`; it is
// not exercised here (the integration stack has no real push vendor, so
// the SW never receives a real PushEvent).

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
  setPageVisibility,
  stubPushManager,
} from "../fixtures/push";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specLiveNick, specNick, specUser, test } from "../fixtures/test";

const PEER_NICK = "fg-suppressor";
const SUB_ID = "foreground-suppression";

test("server suppresses push while a device reports visible, delivers once hidden (#182)", async ({
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

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Phase 1 — device VISIBLE (foreground). The server MUST suppress the
    // whole fan-out; push-catcher sees nothing. setPageVisibility blocks
    // until WSPresence has acked visible=true, so the DM can't race it.
    await setPageVisibility(page, true);
    const visibleBody = "you are looking at the app — no toast please";
    peer.privmsg(await specLiveNick(), visibleBody);
    await assertNoPushDelivery(SUB_ID, {
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      window: peer.nick,
      sender: peer.nick,
      body: visibleBody,
    });

    // Phase 2 — device HIDDEN (backgrounded). The server MUST now deliver.
    await resetPushCatcher();
    await setPageVisibility(page, false);
    const hiddenBody = "now you backgrounded it — deliver this one";
    peer.privmsg(await specLiveNick(), hiddenBody);

    const deliveries = await awaitPushDelivery(SUB_ID, {
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      window: peer.nick,
      sender: peer.nick,
      body: hiddenBody,
    });
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expectRfc8291Delivery(deliveries[0]);
  } finally {
    await peer.disconnect("#182 foreground-suppression done");
  }
});
