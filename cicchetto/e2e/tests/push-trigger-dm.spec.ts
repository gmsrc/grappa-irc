// push-trigger-dm — push notifications cluster B5 spec 4
// (2026-05-14).
//
// Coverage: when a peer sends a private message (PRIVMSG to the
// operator's nick rather than a channel), B4's `Push.Triggers`
// hits the DM branch (`message.channel == own_nick`), evaluates
// `dm_match?/2` (`prefs.private_messages_all` defaults true), and
// fires `Push.Sender.send_to_user`.
//
// Same outcome shape as the channel-mention spec: a vendor-shaped
// HTTP POST lands in push-catcher carrying the RFC 8291 + RFC 8292
// wire format (#1290) — see `expectRfc8291Delivery`.
//
// DM has its own routing concern: the spec uses `enablePushFromSettings`
// + a peer DM `privmsg(specNick(), ...)`. The cic UI does NOT need
// to focus a query window — push fires on the server side regardless
// of cic state, and we want the DM unfocused so dedup doesn't
// short-circuit (dedup is the dedup spec).

import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import {
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
import { expect, specNick, specUser, test } from "../fixtures/test";

const PEER_NICK = "b5-dmer";
const SUB_ID = "dm";

test("DM while push-enabled fires Sender → push-catcher receives a POST", async ({
  page,
  context,
}) => {
  const vjt = specUser();
  await resetPushCatcher();
  await resetPushSubscriptions(vjt.token);
  // Stub MUST install before page.goto (loginAs) — initScripts run
  // for FUTURE navigations only. Setting up after loginAs would
  // never patch the active page's pushManager.
  await stubPushManager(context, { endpoint: pushCatcherEndpoint(SUB_ID) });
  await context.grantPermissions(["notifications"]);

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  await enablePushFromSettings(page, context, { id: SUB_ID, token: vjt.token });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // #182 — background the device so the server delivers. A VISIBLE
    // device now suppresses at source; the foreground case is the
    // push-foreground-suppression spec.
    await setPageVisibility(page, false);

    // PRIVMSG straight to the operator's nick — no JOIN needed.
    // Server-side this hits Session.Server's :persist arm with
    // `channel = own_nick`; Triggers' dm? predicate matches.
    const dmBody = "hi from b5-dmer";
    peer.privmsg(specNick(), dmBody);

    const deliveries = await awaitPushDelivery(SUB_ID, {
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      window: peer.nick,
      sender: peer.nick,
      body: dmBody,
    });
    expect(deliveries.length).toBeGreaterThanOrEqual(1);

    // #1290 — the wire contract, asserted in one place for all five
    // push specs: aes128gcm, salt + sender key in the BODY header, no
    // `encryption:`/`crypto-key:` left over, RFC 8292 `vapid t=…, k=…`.
    expectRfc8291Delivery(deliveries[0]);
  } finally {
    await peer.disconnect("B5 DM done");
  }
});
