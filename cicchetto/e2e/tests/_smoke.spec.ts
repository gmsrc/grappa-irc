// S2 smoke spec — proves the full e2e harness wires up:
//
//   testnet (Bahamut) ↔ peer (irc-framework)
//                    ↔ grappa-test (live IRC session for vjt, autojoined #bofh)
//                    ↔ REST /messages (assertion door)
//
// Flow:
//   1. login fixture provided by globalSetup (token seeded)
//   2. spawn vjt-peer, JOIN #spec-wN, PRIVMSG, then disconnect
//   3. poll grappa's REST messages endpoint until the row appears
//
// No cicchetto involvement — the harness signal we want is "grappa's
// session ↔ scrollback path is alive end-to-end". UI-shaped specs land
// in S3 once this baseline is green.

import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

const PEER_NICK = "vjt-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const MESSAGE_BODY = "smoke-test hello from peer";

test("peer PRIVMSG to #spec-wN persists in grappa scrollback", async () => {
  const vjt = specUser();

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(CHANNEL);
    peer.privmsg(CHANNEL, MESSAGE_BODY);

    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: CHANNEL,
      sender: peer.nick,
      body: MESSAGE_BODY,
    });
  } finally {
    await peer.disconnect("smoke done");
  }

  // Sanity: the seeded login token is non-empty (catches a regression
  // where globalSetup silently no-ops).
  expect(vjt.token.length).toBeGreaterThan(0);
});
