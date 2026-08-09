// #1088 — an informational modal must open only on the client that asked.
//
// Reported by an operator running an IRC client in front of their own grappa:
// every `/who` the client issued opened the WHO modal in cicchetto, on a
// device that had asked for nothing. The cause was structural, not cosmetic —
// every one of these replies (`who_reply`, `names_reply`, `whois_bundle`,
// `whowas_bundle`, `server_reply`, `banlist_bundle`, `links_bundle`) was
// broadcast on `grappa:user:{name}`, a topic that partitions by SUBJECT and
// has no per-connection dimension. One question, a modal on every device.
//
// The fix addresses the reply to the connection that issued the command
// (`Grappa.PubSub.Topic.socket/2`), so this spec needs TWO clients of the
// SAME account — one asking, one watching. A single-page spec cannot see the
// defect at all: the asking client was always served correctly.
//
// Anti-hollow-green: "the bystander shows no modal" is worthless if the
// bystander is simply dead. So the bystander must PROVE it is live and
// receiving on the very same account, by rendering a channel message that
// arrives after the /who — and still show no modal.
//
// Barrier: the asking client's modal is the durable signal that the server
// produced and delivered the reply. Both deliveries would ride the same
// server-side fan-out, so once the asker has rendered it, a bystander that
// was going to receive it has already been sent it.

import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Unique per run so the spec survives `--repeat-each`: a fixed nick would
// collide with the still-connected peer of the previous iteration.
const uniqueNick = () => `i1088-${Math.random().toString(36).slice(2, 8)}`;

test("#1088 — /who opens the modal only on the client that issued it", async ({
  page,
  browser,
}) => {
  const vjt = specUser();
  const peerNick = uniqueNick();

  // The bystander: a second device of the SAME account, in its own browser
  // context so it holds a genuinely separate WebSocket (a second tab of one
  // context would too, but a fresh context also keeps storage disjoint).
  const bystanderCtx = await browser.newContext();
  const bystander = await bystanderCtx.newPage();

  const peer = await IrcPeer.connect({ nick: peerNick });

  try {
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    await loginAs(bystander, vjt);
    await selectChannel(bystander, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    await peer.join(CHANNEL);

    // The asking client. Nobody typed anything on the bystander.
    await composeSend(page, `/who ${CHANNEL}`);

    const askerModal = page.getByTestId("who-modal");
    await expect(askerModal).toBeVisible({ timeout: 5_000 });
    await expect(askerModal.locator(".who-modal-row", { hasText: peerNick })).toBeVisible();

    // The bystander is alive on this account and its stream is flowing: it
    // renders a channel message sent AFTER the reply was delivered to the
    // asker. Without this the assertion below would also pass on a bystander
    // whose socket never came up.
    const liveness = `i1088 bystander is live ${peerNick}`;
    peer.privmsg(CHANNEL, liveness);
    await expect(scrollbackLine(bystander, "privmsg", liveness)).toHaveCount(1, {
      timeout: 10_000,
    });

    // The defect: pre-fix this modal was open here too, on a client that
    // issued no command.
    await expect(bystander.getByTestId("who-modal")).toHaveCount(0);
  } finally {
    await peer.disconnect("#1088 done");
    await bystanderCtx.close();
  }
});
