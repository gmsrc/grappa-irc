// #382 — RFC1459 comma-separated multi-channel JOIN, proven end-to-end
// against the live upstream.
//
// cic already forwards `/join #a,#b` as ONE comma-list POST
// (slashCommands.ts join handler: sigil'd lists pass through unsplit).
// Pre-#382 the SERVER's single-channel validator rejected the comma so the
// whole join died. #382 makes the server honor it: split, validate +
// canonical-fold each element, send ONE multi-target JOIN line, and open a
// :pending → :joined window per channel.
//
// A hollow spec that only checked a single row would pass on the pre-#382
// single-channel path. This asserts BOTH sidebar rows exist AND that each is
// actually JOINED — `selectChannel` with `ownNick` requires the per-channel
// self-JOIN line + the WS-ready seam, which only a resolved :joined window
// satisfies (a greyed :pending / :failed window never renders the self-JOIN
// nor stamps channelReady). That proves the multi-target JOIN reached
// upstream and both channels resolved from ONE command.
//
// vjt creates two fresh per-run channels via ONE `/join #x,#y` (→ sole op of
// each) and PARTs both in `finally`. jsdom/vitest cannot do this — it needs
// the live ircd multi-target JOIN round-trip.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test("#382 — /join #a,#b joins BOTH channels from one comma-list command", async ({ page }) => {
  const vjt = specUser();
  const stamp = Date.now();
  const chanA = `#t382a-${stamp}`;
  const chanB = `#t382b-${stamp}`;

  await loginAs(page, vjt);
  // Focus the autojoin channel first to confirm login + WS-ready before the
  // /join (mirrors issue240 boot order).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  try {
    // ONE comma-list command → server sends ONE multi-target JOIN line.
    await composeSend(page, `/join ${chanA},${chanB}`);

    // BOTH sidebar rows appear (window_pending fires per channel → the
    // synthetic pseudo-row renders for each).
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: chanA }),
    ).toHaveCount(1, { timeout: 15_000 });
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: chanB }),
    ).toHaveCount(1, { timeout: 15_000 });

    // BOTH are actually JOINED, not greyed/pending: selectChannel with
    // ownNick requires the per-channel self-JOIN line + WS-ready seam, which
    // only a resolved :joined window satisfies.
    await selectChannel(page, NETWORK_SLUG, chanA, { ownNick: specNick() });
    await selectChannel(page, NETWORK_SLUG, chanB, { ownNick: specNick() });
  } finally {
    // Explicit-channel /part parts each regardless of focus (both are fresh
    // per-run channels, so cleanup keeps the shared testnet tidy).
    await composeSend(page, `/part ${chanA}`).catch(() => {});
    await composeSend(page, `/part ${chanB}`).catch(() => {});
  }
});
