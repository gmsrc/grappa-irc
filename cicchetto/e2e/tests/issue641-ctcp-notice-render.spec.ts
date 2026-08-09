// Issue #641 — an inbound CTCP reply (a NOTICE carrying \x01VERB [args]\x01)
// that matches no pending /ping rendered its RAW body — \x01 delimiters and
// all — straight into $server (`-peer- ^AVERSION ...^A`), breaking the "cic
// NEVER shows \x01" invariant that only the privmsg CTCP arm (#591) upheld.
//
// The full-stack proof jsdom cannot give (feedback_ux_e2e_mandatory): a REAL
// peer sends an UNSOLICITED CTCP VERSION NOTICE to our upstream nick; grappa
// classifies it (SSOT Grappa.IRC.CTCP.verb_args/1 → typed meta.ctcp_verb) and
// routes the CTCP-framed reply to $server, keeping the body VERBATIM (the \x01
// envelope survives, round-trip fidelity); cic's notice arm now reads the TYPED
// meta and renders a human line "← CTCP VERSION reply from <peer>", with
// U+0001 NEVER reaching the DOM.
//
// VERSION (NOT ping) is the genuinely uncorrelated class this fix must cover:
// after #638, a /ping <service> reply CORRELATES and is consumed upstream
// (subscribe.ts maybeConsumePingReply), so a PING fixture would pass for the
// WRONG reason. A stray VERSION reply has NO correlation machinery — it hits
// the exact fall-through the bug reports.

import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const SERVER_WINDOW_LABEL = "Server";

test("#641 — an uncorrelated CTCP notice renders '← CTCP VERB reply from <peer>', never raw \\x01", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // Per-run unique peer nick + tag: $server accumulates across runs, and a
  // fixed nick is a 433/ghost time bomb under CI rerun (mirrors #591/#637).
  const peerNick = `m641-${crypto.randomUUID().slice(0, 5)}`;
  const tag = `v641-${crypto.randomUUID().slice(0, 8)}`;
  const peer = await IrcPeer.connect({ nick: peerNick });
  try {
    // Unsolicited CTCP VERSION reply straight to our upstream nick — no /ctcp
    // was ever sent, so nothing correlates it. No shared channel needed; a
    // NOTICE to a nick is delivered directly.
    peer.notice(specNick(), `\x01VERSION ${tag}\x01`);

    // Server-side: a CTCP-framed reply is protocol, not a DM, so grappa routes
    // it to $server with the body kept VERBATIM (the \x01 envelope survives) —
    // the typed meta.ctcp_verb that drives the render rides alongside it.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: "$server",
      sender: peer.nick,
      body: `\x01VERSION ${tag}\x01`,
      kind: "notice",
    });

    await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW_LABEL, { awaitWsReady: false });

    // DOM: the human INBOUND line built from typed meta (data-kind=notice),
    // envelope gone. Assert the shape AND that no U+0001 survived to the DOM —
    // the whole point of the fix (the invariant the generic fall-through broke).
    const line = scrollbackLine(
      page,
      "notice",
      new RegExp(`← CTCP VERSION reply from ${peer.nick}: ${tag}`),
    );
    await expect(line).toBeVisible({ timeout: 15_000 });
    expect(await line.textContent()).not.toContain("\x01");
  } finally {
    await peer.disconnect("#641 done");
  }
});
