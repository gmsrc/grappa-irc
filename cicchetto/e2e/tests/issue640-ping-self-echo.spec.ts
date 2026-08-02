// Issue #640 — /ctcp + /ping self-echo must land in the SOURCE window, and a
// CTCP query must NEVER open a query window for the target.
//
// Pre-#640 the outbound CTCP self-echo was a plain PRIVMSG addressed to the
// target: the server persisted it under the target's window AND auto-opened
// that window (#422 outbound-DM auto-open, server-side), while the RTT line was
// synthesised separately in the source window (subscribe.ts) — the two halves
// split across two windows, and pinging anyone (even a nonexistent nick) left a
// phantom query tab behind. #640 routes the echo to the SOURCE window with the
// wire recipient in meta.ctcp_target and skips the auto-open (server
// Session.send_ctcp / cic compose.ts).
//
// This is the acceptance gate per the issue: assert the USER-VISIBLE outcome —
// the echo (and, for a live peer, the RTT) render in the window the operator
// typed /ping in, and NO query window is opened for the target. jsdom cannot
// see any of this: it is the compose → REST → self-echo + reply → WS → render
// path against a real bahamut (feedback_ux_e2e_mandatory).

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("#640 — /ping <nonexistent> echoes in the SOURCE window and opens NO phantom query window", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(composeTextarea(page)).toBeVisible();

  // A dedicated per-run victim nick — NEVER the shared vjt subject, and unique
  // so a phantom left by a regression can't be masked by (or collide with) a
  // prior run's leftover (#5 blast-radius). Nonexistent on the wire: the server
  // 401s it to $server, so there is no RTT — the echo is the sole signal, which
  // is exactly the issue's "/ping <nonexistent> leaves a phantom" scenario.
  const victim = `m640-${crypto.randomUUID().slice(0, 6)}`;
  await composeSend(page, `/ping ${victim}`);

  // The outbound self-echo renders in the SOURCE window (CHANNEL, where /ping
  // was typed) — the target is read off meta.ctcp_target, not the routing key.
  // We are viewing CHANNEL, so its visibility here IS "it landed in the source".
  await expect(
    scrollbackLine(page, "privmsg", new RegExp(`→ CTCP PING \\d+ to ${victim}`)),
  ).toBeVisible({ timeout: 10_000 });

  // And NO query window is opened for the victim — the #640 phantom. The echo
  // above is the barrier: the send is fully processed (persist + broadcast +
  // any auto-open would have fired), so this absence is meaningful, not a race
  // that simply hasn't rendered the tab yet.
  await expect(sidebarWindow(page, NETWORK_SLUG, victim)).toHaveCount(0);
});

test("#640 — /ping <peer> keeps BOTH the echo and the RTT in the source window, no phantom window", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(composeTextarea(page)).toBeVisible();

  // Per-run unique peer nick — a fixed nick is a 433/ghost time bomb under CI
  // rerun + bahamut per-IP clone/flood (see issue591 for the full rationale),
  // and doubles as the dedicated victim (#5).
  const peerNick = `m640-${crypto.randomUUID().slice(0, 5)}`;
  const peer = await IrcPeer.connect({ nick: peerNick });
  try {
    // Arm the peer to echo any CTCP PING token straight back (what a real
    // client does). No shared channel needed — /ping DMs the nick directly.
    peer.answerCtcpPing();
    await composeSend(page, `/ping ${peer.nick}`);

    // The self-echo lands in the SOURCE window (CHANNEL)...
    await expect(
      scrollbackLine(page, "privmsg", new RegExp(`→ CTCP PING \\d+ to ${peer.nick}`)),
    ).toBeVisible({ timeout: 10_000 });

    // ...and so does the RTT reply — the two halves finally converge in ONE
    // window (the whole point of #640; pre-fix the echo was in a phantom tab).
    await expect(
      scrollbackLine(page, "notice", new RegExp(`CTCP PING reply from ${peer.nick}: \\d+ ms`)),
    ).toBeVisible({ timeout: 15_000 });

    // No query window was ever opened for the peer — a CTCP probe is not a DM.
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(0);
  } finally {
    await peer.disconnect("#640 ping done");
  }
});

test("#640 — /ctcp <peer> VERSION self-echoes in the SOURCE window, opens no query window", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(composeTextarea(page)).toBeVisible();

  // /ctcp to a nick has the identical shape as /ping (the issue's "Same for
  // /ctcp <target> <VERB>"). A nonexistent per-run victim is enough — VERSION
  // needs no live replier to prove the echo routing + no-phantom-window.
  const victim = `m640c-${crypto.randomUUID().slice(0, 6)}`;
  const tag = crypto.randomUUID().slice(0, 8);
  await composeSend(page, `/ctcp ${victim} VERSION ${tag}`);

  // Echo in the SOURCE window, target from meta (not the routing key).
  await expect(
    scrollbackLine(page, "privmsg", `→ CTCP VERSION ${tag} to ${victim}`),
  ).toBeVisible({ timeout: 10_000 });

  await expect(sidebarWindow(page, NETWORK_SLUG, victim)).toHaveCount(0);
});
