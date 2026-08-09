// #374 — /motd <target> honors the target server (RFC 2812 §3.4.1). Pre-#374
// the target argument was silently dropped: cic's parser threw `_rest` away
// and grappa emitted a bare `MOTD`, so `/motd <server>` returned the CURRENT
// server's MOTD with NO error — the wrong server's data, silently.
//
// This e2e proves the target now reaches the wire by driving /motd against a
// server that does NOT exist. A bare MOTD can only ever yield the local
// server's MOTD (375/372/376) or 422 ERR_NOMOTD — it can NEVER produce a 402
// ERR_NOSUCHSERVER. So a surfaced 402 is unforgeable proof that grappa emitted
// `MOTD <target>` upstream with the operator's target. Per CLAUDE.md's
// no-silent-swallow rule + #374's non-negotiable, that 402 MUST surface (never
// be swallowed into a wrong-server MOTD): it drains the same ServerReplyModal
// (source "motd") the happy path uses, and clears the primed accumulator.
//
// The server-side threading (client wire, channel target validation,
// EventRouter 402 drain + motd_pending clear) is unit-tested in
// test/grappa/irc/client_test.exs, test/grappa_web/channels/grappa_channel_test.exs,
// and test/grappa/session/event_router_test.exs. The parser + compose plumbing
// is unit-tested in cicchetto/src/__tests__/{slashCommands,compose}.test.ts.

import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// A dotted name that matches no server on the testnet → bahamut answers 402
// ERR_NOSUCHSERVER. No wildcards, so it can never accidentally match a leaf.
const BOGUS_SERVER = "no.such.server.grappa.test";

test("#374 — /motd <unknown-server> surfaces the 402 in the MOTD modal (target reached the wire)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Pre-#374 this arg was dropped and the CURRENT server's MOTD came back with
  // no error. Post-#374 the target is threaded → upstream 402 ERR_NOSUCHSERVER.
  await composeSend(page, `/motd ${BOGUS_SERVER}`);

  // The 402 drains the same typed server_reply modal the happy path uses.
  const modal = page.getByTestId("server-reply-modal");
  await expect(modal).toBeVisible({ timeout: 10_000 });
  await expect(modal).toHaveAttribute("data-source", "motd");
  await expect(modal.locator("#server-reply-modal-title")).toContainText("Message of the Day");

  // The surfaced line is the 402 body — unforgeable proof the target reached
  // upstream (a bare MOTD never yields ERR_NOSUCHSERVER).
  const lines = modal.locator('[data-testid="server-reply-modal-line"]');
  await expect(lines.first()).toBeVisible();
  await expect(lines.filter({ hasText: /no such server/i }).first()).toBeVisible();

  // Never swallowed into scrollback — the drain persists nothing (mirror #127).
  await expect(scrollbackLine(page, "notice", "No such server")).toHaveCount(0);

  // × dismisses the modal.
  await modal.getByLabel("close").click();
  await expect(modal).toBeHidden({ timeout: 2_000 });
});
