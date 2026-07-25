// #376 — /banlist renders a real BanlistCard (banmask + setter), NOT a bare
// set-timestamp, proven end-to-end against the live upstream.
//
// Pre-#376 the 367 RPL_BANLIST / 368 RPL_ENDOFBANLIST numerics were not
// delegated: each ban leaked as a bare `$server` :notice row whose body was
// the trailing param (the set-time unix timestamp). #376 wires the full
// bundle end-to-end (grappa fold + broadcast → cic BanlistCard). This
// witness drives the real path: an op sets a ban then issues /banlist, and
// we assert the card shows the banmask + the setter — the fields that were
// dropped. A hollow spec checking only "card exists" would pass without the
// wire carrying the entry; asserting the mask + setter proves the fold ran.
//
// vjt creates a fresh per-run channel (→ sole op, so +b is allowed and no
// peer is needed) and PARTs it in `finally`. Setting +b is a normal channel
// op (unlike #375's oper-only verbs — no SIGSEGV risk). jsdom/vitest cannot
// do this — it needs the live ircd MODE + 367/368 round-trip.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

test("#376 — an op sets +b then /banlist renders the mask + setter (not a bare ts)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const channel = `#t376-${Date.now()}`;
  // A distinctive host so the mask is uniquely assertable in the card.
  const banMask = `*!*@t376-${Date.now() % 1000000}.example`;

  await loginAs(page, vjt);
  // Focus the autojoin channel first to confirm login + WS-ready before the
  // /join (mirrors issue240 boot order).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  try {
    // vjt creates the channel → becomes op (@) → +b is allowed.
    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });

    // Set the ban, then query the ban list. The 367 the server sends back
    // carries {mask, setter (vjt!...), set_ts}; 368 closes the bundle.
    await composeSend(page, `/ban ${banMask}`);
    await composeSend(page, `/banlist ${channel}`);

    // The card renders inline above the active window's scrollback.
    const card = page.getByTestId("banlist-card");
    await expect(card).toBeVisible({ timeout: 15_000 });

    // #376 core: the banmask is rendered (it was dropped pre-fix).
    await expect(card).toContainText(banMask, { timeout: 15_000 });

    // The setter is rendered — bahamut's 367 setter field carries vjt's
    // nick!user@host, so the nick appears. This is the field the leak
    // dropped: proof the row is a real entry, not a bare timestamp.
    await expect(card).toContainText(NETWORK_NICK);
    await expect(card).toContainText("set by");
  } finally {
    // Best-effort cleanup: drop the ban then leave the channel.
    await composeSend(page, `/unban ${banMask}`).catch(() => {});
    await composeSend(page, `/part ${channel}`).catch(() => {});
  }
});
