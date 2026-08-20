// Issue #637 — /ping <service> (NickServ) never renders the RTT line, while
// /ping <human> works in the same session. The full round-trip regression gate
// (compose → REST → real NickServ echo → WS → render) — the acceptance proof
// jsdom + hand-fed unit tests cannot give.
//
// ROOT CAUSE (measured against the live azzurra-services on the bahamut-test
// hub): NickServ answers a CTCP PING with a BARE `\x01PING\x01`, DROPPING the
// token — unlike a normal client (or shottino), which echoes the token
// verbatim. grappa routes the CTCP-framed reply to $server and hands cic an
// EMPTY `ctcp_args`; pre-#637 the token-keyed pending entry never matched an
// empty token, so the RTT never rendered (while /ping <human> did — the exact
// human control the report cites). The fix: cic's pingCorrelation falls back to
// the most-recent pending ping to that (network, nick) for a TOKEN-LESS reply.
//
// If NickServ ever stops echoing, this goes red loudly (element-not-found)
// rather than silently passing — the #78 "green while broken" trap.

import {
  composeSend,
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("#637 — /ping NickServ (a real service, token-less echo) renders the round-trip line", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(composeTextarea(page)).toBeVisible();

  // /ping NickServ from #spec-wN. NickServ echoes a TOKEN-LESS CTCP PING; grappa
  // routes the CTCP-framed reply to $server; cic's correlation gate falls back
  // to the pending ping by nick and synthesises the RTT row in the source
  // window (#spec-wN).
  await composeSend(page, "/ping NickServ");

  await expect(scrollbackLine(page, "notice", /CTCP PING reply from NickServ: \d+ ms/)).toBeVisible(
    { timeout: 20_000 },
  );
});
