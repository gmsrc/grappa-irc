// Issue #367 — WHOIS 313 RPL_WHOISOPERATOR role text.
//
// The bug: the WhoisCard collapsed 313 into a bare "oper" badge and threw
// away the ircd's descriptive trailing text, so a viewer could not tell an
// ordinary IRC Operator apart from a Server / Services Administrator. The
// fix captures the trailing verbatim as `oper_text` on the server
// (EventRouter 313 handler → whois bundle), ships it over the wire, and
// renders it as a `.whois-card-oper-text` row in cic (KEEPING the "oper"
// badge as the always-on flag + the bare-313 fallback).
//
// What this e2e proves end-to-end (the integration-level companion to the
// exhaustive unit coverage in `event_router_test.exs` +
// `wire_test.exs` + `WhoisCard.test.tsx`):
//   1. A peer OPERs up against the testnet O:line (`testoper`/`testoperpass`,
//      host-`*@*`, same creds as issue148-visitor-oper) → real 381.
//   2. vjt issues `/whois <peer>` from the compose box.
//   3. bahamut answers with a real 313 carrying the operator role text; the
//      WhoisCard renders it in the `.whois-card-oper-text` row — the exact
//      thing that was dropped pre-#367.
//
// The role text is matched on the stable `/operator|administrator/i` core
// phrase (NOT pinned to an exact string) — bahamut's 313 wording depends on
// the oper's level, and the same tolerance discipline as issue148's 381
// regex applies. The bare-313 fallback (badge only, no row) can't be forced
// on a live ircd, so it is covered by the WhoisCard.test.tsx unit.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const PEER_NICK = "oper367-target";
const CHANNEL = AUTOJOIN_CHANNELS[0];
// Testnet O:line creds — host-unrestricted, NAME field is `testoper`
// (infra/compose.yaml OPER_NICK). Same as issue148-visitor-oper.
const OPER_NAME = "testoper";
const OPER_PASS = "testoperpass";
// The ircd role text distinguishes oper levels; match the stable phrase.
const OPER_ROLE_TEXT_RE = /operator|administrator/i;

test("issue #367 — /whois of an opered peer renders the 313 role text row", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Peer must be reachable for a non-empty WHOIS + must be opered so the
    // upstream emits 313 RPL_WHOISOPERATOR with the role text.
    await peer.join(CHANNEL);
    await peer.oper(OPER_NAME, OPER_PASS);

    // Issue /whois from cic's compose box.
    await composeSend(page, `/whois ${peer.nick}`);

    const card = page.getByTestId("whois-card");
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card.locator(".whois-card-target")).toHaveText(peer.nick);

    // #367 — the "oper" badge signals operator status at a glance...
    await expect(card.locator(".whois-card-tag-oper")).toBeVisible({ timeout: 5_000 });

    // ...and the role-text row carries the ircd's descriptive level string
    // (dropped entirely before #367). This is the regression the fix closes.
    const operRow = card.locator(".whois-card-oper-text");
    await expect(operRow).toBeVisible({ timeout: 5_000 });
    await expect(operRow).toHaveText(OPER_ROLE_TEXT_RE);
  } finally {
    await peer.disconnect("issue367 done");
  }
});
