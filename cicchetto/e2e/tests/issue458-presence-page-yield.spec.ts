// #458 — filter join/part/quit/nick_change out of the scrollback REST reads
// SERVER-SIDE so `limit` counts VISIBLE rows. Before the fix, `limit` applied to
// RAW rows while cic hides the four presence kinds at render time (#222): on a
// channel crowded with join/part/quit churn a page-up (or cold-load) returned a
// page that was ALL hidden rows, so the pane rendered few visible rows or NONE.
//
// ## What this e2e owns vs what the unit tests own
//
// The >50-rows "limit counts VISIBLE rows" MATH is proven deterministically —
// with no IRC flood — in `test/grappa/scrollback_test.exs` ("fetch/6
// hide_presence … one page-up is one screenful"), which seeds >limit presence
// rows straight into the DB. Mirroring the #222 e2e (which likewise deferred the
// 50-member size math to the vitest boundary test), THIS spec owns the
// INTERACTIVE WIRING the unit tests can't reach:
//
//   1. the pref PERSISTS server-side and a reload's cold-load RESPECTS it (the
//      server omits presence rows from the page, not just render-hides them); and
//   2. revealing presence REFETCHES — the #458 cic change. Because the server
//      never sent the hidden rows, flipping the pref back to "show" must purge +
//      cold-reload (`syncedSetChannelPresencePref`), awaiting the persist PUT
//      first so the refetch reads-its-write. RED without that hook: the rows were
//      filtered out of the store, so a render-only reveal has nothing to show.
//
// ## Volume is deliberately LOW
//
// The e2e testnet is BAHAMUT (NETWORK_SLUG "bahamut-test"; IrcPeer defaults to
// that leaf), which applies per-connection FAKE-LAG (~10s bank) — so a burst of
// NICK changes on one connection risks NICK_TIMEOUT / budget flake
// (feedback_e2e_peer_burst_flood_and_split). Three nick_change rows is plenty to
// witness the wiring and stays well under the fake-lag bank. The row-count math
// lives in ExUnit precisely so this spec need not manufacture 50+ presence rows.
//
// Desktop project (untagged → chromium; NO @webkit). Per feedback_ux_e2e_
// mandatory: every cic UX-touching change ships a Playwright e2e.

import { loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(90_000);

test("#458 — presence pref persists, cold-load respects it, and revealing refetches", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: "n458start" });
  try {
    await peer.join(CHANNEL);
    // One content row (the load witness) + three nick_change rows (a suppressed
    // kind). Same TCP socket ⇒ the content is ordered before the churn.
    peer.privmsg(CHANNEL, "issue458-content");
    for (let i = 0; i < 3; i++) await peer.changeNick(`n458p${i}`);

    const contentRow = page
      .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
      .filter({ hasText: "issue458-content" });
    const nickRows = page.locator('[data-testid="scrollback-line"][data-kind="nick_change"]');

    // Baseline: default (unset) pref on a small channel → presence SHOWN.
    await expect(contentRow).toHaveCount(1, { timeout: 15_000 });
    await expect(nickRows).toHaveCount(3, { timeout: 10_000 });

    // Toggle HIDE and AWAIT the persist PUT before reloading: the reload's
    // cold-load resolves hide_presence from the PERSISTED pref, so an in-flight
    // PUT would race an unfiltered fetch.
    await openRailMenu(page);
    const toggle = page.locator('[data-testid="presence-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    const hidePut = page.waitForResponse(
      (r) =>
        r.url().includes("/me/settings/display-prefs") && r.request().method() === "PUT" && r.ok(),
    );
    await toggle.click();
    await hidePut;
    await expect(nickRows).toHaveCount(0, { timeout: 5_000 }); // render-filter drops them

    // WIRING 1 — reload → cold-load with the persisted "hide". The server OMITS
    // the nick_change rows from the page (not just render-hides them); content
    // still lands. (The equivalent >limit-rows yield is the ExUnit proof.)
    await page.reload();
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });
    await expect(contentRow).toHaveCount(1, { timeout: 15_000 });
    await expect(nickRows).toHaveCount(0);

    // WIRING 2 — toggle SHOW. `syncedSetChannelPresencePref` awaits the persist
    // PUT, then purges + cold-reloads, so the server RE-INCLUDES the nick_change
    // rows and they re-appear. RED without the refetch hook (or with the pre-fix
    // race): the rows are absent from the store, so nothing renders.
    await openRailMenu(page);
    const toggleAfter = page.locator('[data-testid="presence-toggle"]');
    await expect(toggleAfter).toBeVisible({ timeout: 5_000 });
    await toggleAfter.click();
    await expect(nickRows.first()).toBeVisible({ timeout: 15_000 });
    await expect(nickRows).toHaveCount(3, { timeout: 15_000 });
  } finally {
    await peer.disconnect("458 witness done");
  }
});
