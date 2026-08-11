// Issue #1225 — /notice must reach the wire as a NOTICE and self-echo in the
// SOURCE window, opening no window for the recipient.
//
// Before #1225 the verb did not exist: `/notice nick text` fell through to the
// unknown-command error, and the only way out was `/quote NOTICE nick :text`
// (hand-typed trailing colon, no echo at all). The send half now mirrors #640's
// CTCP routing — echo keyed to the window it was typed in, recipient carried in
// meta.notice_target — with a NOTICE on the wire and a `:notice` row kind.
//
// Two things only a real stack can prove, and this is the acceptance gate for
// both (feedback_ux_e2e_mandatory):
//   1. the WIRE VERB. A PRIVMSG implementation renders an identical echo; the
//      only witness that distinguishes them is a live peer seeing `NOTICE` on
//      its socket. jsdom cannot see a socket.
//   2. the echo landing in the source window against a real persist +
//      broadcast, rather than a stubbed store.

import {
  composeSend,
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("#1225 — /notice <peer> reaches the peer as a NOTICE and echoes in the SOURCE window", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(composeTextarea(page)).toBeVisible();

  // Per-run unique peer nick — a fixed one is a 433/ghost time bomb under CI
  // rerun plus bahamut's per-IP clone limit (the #591/#640 rationale).
  const peerNick = `m1225-${crypto.randomUUID().slice(0, 5)}`;
  const tag = crypto.randomUUID().slice(0, 8);
  const peer = await IrcPeer.connect({ nick: peerNick });
  try {
    // Arm BEFORE the send: the peer's socket can deliver the frame before
    // Playwright gets back from composeSend, and a listener attached after the
    // fact would wait for a line that already came and went.
    //
    // The pattern pins the VERB and the recipient. This is the assertion a
    // PRIVMSG-shaped implementation cannot satisfy, so it is the one that makes
    // the whole spec worth running.
    const noticeOnTheWire = peer.waitForLine(
      new RegExp(`NOTICE ${peer.nick} :${tag}`),
      `NOTICE to ${peer.nick}`,
    );

    await composeSend(page, `/notice ${peer.nick} ${tag}`);
    await noticeOnTheWire;

    // The self-echo renders where the operator typed it (we are viewing
    // CHANNEL, so its visibility here IS "it landed in the source window"), and
    // it names the RECIPIENT — not the window, which is what reading the
    // routing key instead of meta.notice_target would print.
    await expect(scrollbackLine(page, "notice", `→ -${peer.nick}- ${tag}`)).toBeVisible({
      timeout: 10_000,
    });

    // No query window for the recipient: a notice opens none. The two awaits
    // above are the barrier — the send is fully processed, so this absence is a
    // decision, not a tab that has yet to render.
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(0);
  } finally {
    await peer.disconnect("#1225 notice done");
  }
});

test("#1225 — /notice #chan reaches the channel and echoes in the window it was typed in", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(composeTextarea(page)).toBeVisible();

  // A CHANNEL recipient is the form an operator actually reaches for, and the
  // one /msg refuses. Witness is a peer sitting IN the channel: it only sees
  // the frame if bahamut accepted and relayed a channel-targeted NOTICE.
  const peerNick = `m1225c-${crypto.randomUUID().slice(0, 5)}`;
  const tag = crypto.randomUUID().slice(0, 8);
  const peer = await IrcPeer.connect({ nick: peerNick });
  try {
    await peer.join(CHANNEL);

    const noticeOnTheWire = peer.waitForLine(
      new RegExp(`NOTICE ${CHANNEL} :${tag}`),
      `NOTICE to ${CHANNEL}`,
    );

    await composeSend(page, `/notice ${CHANNEL} ${tag}`);
    await noticeOnTheWire;

    // Source window and recipient coincide here, so the echo's own text is what
    // separates a notice from a plain say: the arrow + `-recipient-` framing.
    await expect(scrollbackLine(page, "notice", `→ -${CHANNEL}- ${tag}`)).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await peer.disconnect("#1225 channel notice done");
  }
});
