// #188 — "while you were /away" mentions panel: restyle + open-button +
// clear-on-away lifecycle.
//
// This drives the REAL server path end to end — no synthetic bundle:
//   1. operator joins two channels (#spec-wN autojoin + a fresh #m188)
//   2. operator goes `/away`
//   3. a peer PRIVMSGs the operator's nick into BOTH channels while away
//   4. operator comes back (bare `/away`) → server's
//      `maybe_broadcast_mentions_bundle` aggregates the two nick-mentions
//      and pushes `mentions_bundle` → cic auto-opens the panel
//
// Then it asserts the polished panel (#188):
//   * heading leads with "while you were /away" + a "N messages in M
//     channels" count
//   * rows are grouped under a muted per-channel label
//   * the list is a scroll container
//   * clicking a row jumps to that channel window
//   * the open-button next to the cog re-opens the panel
//   * the close-x returns to the previous window
//   * going `/away` AGAIN clears the bundle (the open-button disappears)
//
// Untagged → runs in the chromium (desktop) project.

import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const PEER_NICK = "m188-peer";
const CHANNEL_A = AUTOJOIN_CHANNELS[0]; // "#spec-wN" — already joined at login
const CHANNEL_B = "#m188"; // fresh channel this operator joins
const AWAY_REASON = "lunch break";
// Bodies mention the operator's nick at a word boundary so the server's
// mention aggregation (own-nick regex) matches them. A per-invocation
// `runId` suffix is LOAD-BEARING, not cosmetic: `#m188` is NOT in the
// seeded autojoin set, so the wrapped `test` fixture's `_vjtReset`
// (which truncates + reseeds only AUTOJOIN_CHANNELS = #spec-wN) leaves
// prior-iteration `ping in m188` rows in #m188's scrollback. With a
// constant body, the `scrollbackLine(...).first()` wait below would
// match a STALE row and false-pass WITHOUT the fresh BODY_B having
// persisted — so the unaway aggregation races and under-counts (the
// self-poisoning "1 message in 1 channel" / "0 messages" flake seen
// under --repeat-each). A fresh runId per test invocation makes each
// wait a true "the FRESH mention landed" precondition.
const mentionBody = (where: string, runId: string): string =>
  `${specNick()} ping in ${where} ${runId}`;

test("#188 — away mentions panel: grouped restyle, open-button, close-x, clear-on-away", async ({
  page,
}) => {
  const vjt = specUser();
  // Per-invocation unique suffix — see `mentionBody` comment: guards the
  // scrollback-render waits below against matching a stale prior-iteration
  // `#m188` row (which _vjtReset does not truncate).
  const runId = crypto.randomUUID().slice(0, 8);
  const bodyA = mentionBody("bofh", runId);
  const bodyB = mentionBody("m188", runId);
  await loginAs(page, vjt);

  // Join both channels (subscribed + confirmed via the self-JOIN line).
  await selectChannel(page, NETWORK_SLUG, CHANNEL_A, { ownNick: specNick() });
  await composeSend(page, `/join ${CHANNEL_B}`);
  await selectChannel(page, NETWORK_SLUG, CHANNEL_B, { ownNick: specNick() });

  // Go away — the server stamps the away-window start.
  await composeSend(page, `/away ${AWAY_REASON}`);

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(CHANNEL_A);
    await peer.join(CHANNEL_B);

    // Highlight in #spec-wN FIRST (focus it so the live push renders, which
    // confirms the row persisted server-side before we unaway). Ordering
    // A-then-B makes the aggregated bundle deterministic (server_time ASC),
    // so the groups render #spec-wN then #m188.
    await selectChannel(page, NETWORK_SLUG, CHANNEL_A, { awaitWsReady: false });
    peer.privmsg(CHANNEL_A, bodyA);
    await expect(scrollbackLine(page, "privmsg", `ping in bofh ${runId}`).first()).toBeVisible({
      timeout: 10_000,
    });

    await selectChannel(page, NETWORK_SLUG, CHANNEL_B, { awaitWsReady: false });
    peer.privmsg(CHANNEL_B, bodyB);
    await expect(scrollbackLine(page, "privmsg", `ping in m188 ${runId}`).first()).toBeVisible({
      timeout: 10_000,
    });

    // Come back → server aggregates the two mentions and pushes
    // `mentions_bundle` → cic AUTO-FOCUSES the mentions pseudo-window,
    // which unmounts the ComposeBox. `expectUnmount` waits for that
    // textarea unmount (the auto-open signal) instead of the
    // textarea-empty signal that a normal submit would leave.
    await composeSend(page, "/away", { expectUnmount: true });

    const panel = page.getByTestId("mentions-window");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Heading: "/away" phrasing + a count that spans both channels.
    const header = page.getByTestId("mentions-header");
    await expect(header).toContainText("while you were /away");
    await expect(header).toContainText("2 messages in 2 channels");
    // Away reason survives in the muted sub-line.
    await expect(header).toContainText(AWAY_REASON);

    // Grouped by channel under muted labels, in send order.
    await expect(page.getByTestId("mentions-group")).toHaveCount(2);
    await expect(page.getByTestId("mentions-group-channel")).toHaveText([CHANNEL_A, CHANNEL_B]);

    // Scroll container present (item 4).
    await expect(page.getByTestId("mentions-list")).toBeVisible();

    // Rows are clickable and jump to the source channel window (item 3 /
    // C8.2). Click the #spec-wN row → panel closes, the #spec-wN window shows.
    const bofhRow = page
      .getByTestId("mentions-group")
      .filter({ hasText: CHANNEL_A })
      .getByTestId("mentions-row")
      .first();
    await bofhRow.click();
    await expect(panel).toHaveCount(0);
    await expect(scrollbackLine(page, "privmsg", `ping in bofh ${runId}`).first()).toBeVisible();

    // #71 INC-2 (Q1) — on DESKTOP the @ open-mentions button was removed from
    // ShellChrome; the per-network Sidebar mentions row is the re-open door
    // now (conditional on a bundle existing for that network, like the archive
    // list). It re-opens the panel (item 6).
    const mentionsRow = page.getByTestId(`sidebar-mentions-row-${NETWORK_SLUG}`);
    await expect(mentionsRow).toBeVisible();
    await mentionsRow.click();
    await expect(panel).toBeVisible();

    // Close-x returns to the previous window (item 5).
    await page.getByTestId("mentions-close").click();
    await expect(panel).toHaveCount(0);

    // Clear-on-away lifecycle (item 7): going /away again drops the bundle,
    // so the Sidebar mentions row (gated on bundle existence) disappears.
    // We're back on the #spec-wN window (close-x restored it), which has a
    // compose box.
    await expect(mentionsRow).toBeVisible();
    await composeSend(page, "/away second time");
    await expect(mentionsRow).toHaveCount(0, { timeout: 5_000 });
  } finally {
    await peer.disconnect("bye");
  }
});
