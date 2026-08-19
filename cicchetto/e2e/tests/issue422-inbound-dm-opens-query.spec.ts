// #422 — an inbound DM must open its query window SERVER-SIDE (next to the
// persist), so it surfaces even when the auto-open no longer lives in the
// client. cic's own-nick dm-listener DROPPED its `openQueryWindowState`
// calls (Option B — "cic NEVER originates state"); the SERVER opens the
// window (`Session.Server` → `QueryWindows.open`) and broadcasts
// `query_windows_list`. cic is now a pure renderer.
//
// This e2e proves PARITY IS DEMONSTRATED, NOT ASSUMED: with the client
// auto-open removed, an inbound DM STILL opens the query window. If the
// server did not open it, this spec would see ZERO query rows — a direct
// regression signal for the removed client path.
//
// Two facets in one flow (they share the seeded `vjt` grappa session):
//   1. LIVE: the operator is connected; a peer they never queried DMs them
//      → the query row appears with NO user action (no /q, no click) —
//      driven solely by the server's `query_windows_list` broadcast.
//   2. SERVER-OWNED (the #422 repro): reload → a fresh after-join snapshot
//      STILL carries the window. It is persisted server-side, not
//      client-only state a reload would drop. Maps to the issue's "log
//      back in → peer appears in the active list, not Archive."
//
// Per `feedback_ux_e2e_mandatory` (a UX-behaviour change ships a Playwright
// e2e — vitest jsdom can't see the WS→sidebar wiring) and
// `feedback_e2e_user_class_parity_matrix` (server-owned auto-open is
// subject-agnostic, one user-class spec suffices). No `@webkit` tag →
// desktop/chromium project only, so the `.shell-sidebar` selector applies.

import { loginAs, waitForDmListenerReady } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specLiveNick, specUser, test } from "../fixtures/test";

// Per-run-unique peer nick — bahamut holds a ghosted nick for a linger
// window after disconnect, so a fixed literal 433s on rapid reruns
// (static peer nicks must be per-run-unique).
const PEER_NICK = `dm422p${crypto.randomUUID().slice(0, 6)}`;

test("inbound DM opens the query window server-side (cic pure renderer) and survives reload", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Gate on the own-nick (DM-listener) topic subscription so the peer's DM
  // fans out to a subscribed socket for the LIVE assertion below.
  await waitForDmListenerReady(page, NETWORK_SLUG);

  const sidebar = page.locator(".shell-sidebar");
  // Case-insensitive so a phantom differently-cased row WOULD be counted.
  const queryRow = sidebar.locator(".sidebar-channel-name", {
    hasText: new RegExp(`^${PEER_NICK}$`, "i"),
  });

  // Pre-condition: no query window with this peer exists yet.
  await expect(queryRow).toHaveCount(0);

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // The operator NEVER opened a query with this peer — no /q, no click.
    // An unsolicited inbound DM is the ONLY trigger.
    peer.privmsg(await specLiveNick(), "unsolicited DM #422");

    // FACET 1 — the window appears with cic as a pure renderer: the server
    // opened it + broadcast the list. (Client auto-open is gone; if the
    // server didn't open it, this stays 0 → test fails.)
    await expect(queryRow).toHaveCount(1, { timeout: 10_000 });
    await expect(queryRow.first()).toHaveText(PEER_NICK);

    // FACET 2 — server-owned persistence: a reload rebuilds cic from the
    // stored token; the fresh after-join snapshot STILL carries the window
    // (the #422 repro: "log back in → peer in the active list").
    await page.reload();
    await page.locator(".sidebar-network-header").first().waitFor({ timeout: 10_000 });
    await expect(queryRow).toHaveCount(1, { timeout: 10_000 });
    await expect(queryRow.first()).toHaveText(PEER_NICK);
  } finally {
    await peer.disconnect("#422 done");
  }
});
