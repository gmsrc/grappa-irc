// #458 — filter join/part/quit/nick_change out of the scrollback REST page
// SERVER-SIDE so `limit` counts VISIBLE rows. Before the fix, `limit` applied to
// RAW rows while cic hides the four presence kinds at render time (#222): on a
// channel crowded with join/part/quit churn a page-up (or a cold-load) returned
// a page that was ALL hidden rows, so the pane rendered few visible rows or NONE
// — the reported bug. The fix moves the presence filter into SQL, so a page of
// `limit` rows is `limit` rows the operator will actually SEE.
//
// This spec is the interactive witness for the VISIBLE outcome, exercising the
// real HTTP + WS stack (not the unit-level SQL, which server ExUnit owns). Two
// discriminating assertions:
//
//   Witness 1 (the server filter yields content). With the channel's pref pinned
//   "hide" and 60 nick_change rows newer than a handful of OLD content rows, a
//   fresh cold-load returns the OLD content — because the server skips the 60
//   hidden rows when counting the 50-row page. PRE-FIX the cold-load returned 50
//   RAW rows (all nick_change, all render-hidden), so the OLD content sat past
//   raw-position 50, never fetched → invisible. RED before the SQL filter.
//
//   Witness 2 (refetch on reveal — the cic half of #458). Because the server
//   never sent the hidden rows, flipping the pref back to "show" needs a refetch:
//   `syncedSetChannelPresencePref` purges + cold-reloads on "show". Toggling show
//   makes the nick_change rows RE-APPEAR. RED without the displayPrefs refetch
//   hook: the rows were filtered out of the store server-side, so a render-only
//   reveal would have nothing to show.
//
// Volume note: the e2e testnet is SOLANUM with flood protection deliberately
// relaxed (infra-solanum/ircd.conf.tmpl: number_per_ip=400, anti_nick_flood=no,
// client_flood_max_lines=100), so one peer NICK-cycling 60 times is safe here —
// unlike prod bahamut, where #222's spec avoided volume to dodge autokill.
//
// Desktop project (untagged → chromium; NO @webkit). Per feedback_ux_e2e_
// mandatory: every cic UX-touching change ships a Playwright e2e.

import { loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// > the 50-row default page (@default_limit) with margin, so the OLD content
// sits well past raw-position 50 and is invisible unless the server filters.
const NICK_CHURN = 60;

test.setTimeout(120_000);

test("#458 — a channel crowded with hidden presence still yields visible content", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: "n458start" });
  try {
    await peer.join(CHANNEL);

    // A handful of OLD content rows — the reachable witnesses. Sent FIRST, so
    // they are older than the churn that follows and fall past the raw page.
    for (let i = 1; i <= 5; i++) peer.privmsg(CHANNEL, `issue458-old-${i}`);

    // The "crowd": 60 nick_change rows (a suppressed kind), newest in the
    // channel. Same TCP socket ⇒ ordered after the OLD content above.
    for (let i = 0; i < NICK_CHURN; i++) await peer.changeNick(`n458p${i}`);

    // Sync barrier: a final VISIBLE marker. Its arrival in cic proves the WS
    // pipeline drained (and thus the server persisted everything before it,
    // TCP-ordered) — so the cold-load after reload sees the full history.
    peer.privmsg(CHANNEL, "issue458-marker");
    const markerRow = page
      .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
      .filter({ hasText: "issue458-marker" });
    await expect(markerRow).toHaveCount(1, { timeout: 15_000 });

    // Pin the channel pref to "hide" via the real toggle (persists server-side
    // via the #449 coordinator PUT). Await the PUT's response before reloading:
    // the reload's cold-load resolves hide_presence from the PERSISTED pref, so
    // an in-flight PUT would race an unfiltered fetch.
    await openRailMenu(page);
    const toggle = page.locator('[data-testid="presence-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    const hidePut = page.waitForResponse(
      (r) =>
        r.url().includes("/me/settings/display-prefs") &&
        r.request().method() === "PUT" &&
        r.ok(),
    );
    await toggle.click();
    await hidePut;

    // WITNESS 1 — reload → cold-load with hide_presence=true. The server skips
    // the 60 nick_change rows when filling the 50-row page, so the OLD content
    // (raw-position >50) is now in the page and VISIBLE. PRE-FIX: the raw page
    // was 50 nick_change rows, all hidden, and the OLD content was never fetched.
    await page.reload();
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });
    for (let i = 1; i <= 5; i++) {
      await expect(
        page
          .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
          .filter({ hasText: `issue458-old-${i}` }),
      ).toHaveCount(1, { timeout: 15_000 });
    }
    // ...and the presence crowd stays hidden under the pref (no DOM node).
    await expect(page.locator('[data-testid="scrollback-line"][data-kind="nick_change"]')).toHaveCount(
      0,
    );

    // WITNESS 2 — toggle the pref back to "show". `syncedSetChannelPresencePref`
    // purges + cold-reloads on "show", so the server re-includes the nick_change
    // rows and they RE-APPEAR. Without the refetch hook they would stay gone:
    // the server filtered them out of the store, so there is nothing to reveal.
    await openRailMenu(page);
    const toggleAfterReload = page.locator('[data-testid="presence-toggle"]');
    await expect(toggleAfterReload).toBeVisible({ timeout: 5_000 });
    await toggleAfterReload.click();
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="nick_change"]').first(),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await peer.disconnect("458 witness done");
  }
});
