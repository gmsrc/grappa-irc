// Issue #591 — cicchetto's CTCP send side: `/ctcp` + `/ping`.
//
// Two full-stack round-trips jsdom cannot see (per feedback_ux_e2e_mandatory
// + feedback_cicchetto_browser_smoke — the compose → REST → self-echo/reply →
// WS → render path only exists against a real bahamut + a real peer):
//
//   1. /ctcp <target> <VERB> [args] — the operator's OWN outbound CTCP query
//      self-echoes as a :privmsg carrying the raw `\x01VERB args\x01` body.
//      The server tags it with typed meta (Grappa.IRC.CTCP.verb_args/1) and
//      ScrollbackPane renders "→ CTCP VERB args to <target>" — NOT the raw
//      \x01, which pre-#591 surfaced as a bare "<nick> VERB" chat row. cic
//      never parses \x01; the render keys off the typed meta only.
//
//   2. /ping <target> — CTCP PING sugar. compose stamps a client-timestamp
//      token, the peer echoes it back verbatim as a CTCP PING NOTICE, grappa
//      routes that CTCP-framed reply to `$server` (86416a21/96bedfdd — a CTCP
//      reply is protocol, not a DM), and cic's correlation gate
//      (subscribe.ts) synthesises "CTCP PING reply from <peer>: N ms" in the
//      window the /ping was typed in (irssi behaviour; RTT decoupled from the
//      reply's routing).

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = "m591peer";

test("#591 — own /ctcp query self-echoes as '→ CTCP VERB args to target', not raw \\x01", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(composeTextarea(page)).toBeVisible();

  // Per-run unique arg so the shared #bofh scrollback doesn't accumulate
  // strict-mode-colliding duplicate lines across runs (mirrors issue14/m10).
  const tag = `v591-${crypto.randomUUID().slice(0, 8)}`;
  await composeSend(page, `/ctcp ${CHANNEL} VERSION ${tag}`);

  // Server-side: the outbound self-echo persists as :privmsg with the raw
  // \x01 body verbatim (round-trip fidelity) — the typed meta that drives the
  // render rides alongside it.
  await assertMessagePersisted({
    token: vjt.token,
    networkSlug: NETWORK_SLUG,
    channel: CHANNEL,
    sender: NETWORK_NICK,
    body: `\x01VERSION ${tag}\x01`,
    kind: "privmsg",
  });

  // DOM: rendered as the CTCP query line (data-kind=privmsg), envelope gone.
  await expect(
    scrollbackLine(page, "privmsg", `→ CTCP VERSION ${tag} to ${CHANNEL}`),
  ).toBeVisible({ timeout: 10_000 });
});

test("#591 — /ping shows the round-trip time in the source window", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(composeTextarea(page)).toBeVisible();

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Arm the peer to echo any CTCP PING token straight back (what a real
    // client does). No shared channel needed — /ping DMs the nick directly.
    peer.answerCtcpPing();
    await composeSend(page, `/ping ${peer.nick}`);

    // The reply is CTCP-framed → grappa routes it to $server with typed ctcp
    // meta; cic ALWAYS subscribes to $server, correlates the token back to the
    // pending /ping, and synthesises the round-trip line in the SOURCE window
    // (#bofh, where /ping was typed). The ms is wall-clock — assert the shape.
    await expect(
      scrollbackLine(page, "notice", new RegExp(`CTCP PING reply from ${peer.nick}: \\d+ ms`)),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await peer.disconnect("#591 ping done");
  }
});
