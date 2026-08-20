// #973 — the unread badge on a QUERY window must clear when the operator
// reads it, and STAY clear.
//
// Reported on 0.13.1: in a DM the badge only ever grew. Channels were fine.
// The cursor map was written under the peer nick in the casing the window
// wears (`query_windows.target_nick` is case-preserving server-side, and
// `canonicalQueryNick` resolves a selection to that spelling — it is not a
// fold) and read back under the ASCII-FOLDED name the badge memo decodes out
// of a `ChannelKey`. Two keys, one map. The only writer that ever landed the
// folded key was the `/me` cold load, so the count was right at page load and
// wrong forever after. Fixed by folding inside `readCursor.ts`'s `cacheKey` —
// the single door every cursor writer and reader already passes through.
//
// Why this spec exists on top of the vitest boundary tests
// (src/__tests__/queryUnreadBadgeCasing.test.ts): those drive the store's
// entry points directly and prove the KEYS agree. They cannot prove the pill
// leaves the screen. The reported symptom is a number the operator can see, so
// the witness has to be the rendered badge, reached through the real settle
// path (open the window, read, leave) rather than a synthetic cursor write.
// Per feedback_ux_e2e_mandatory: every cic UX-touching change ships one.
//
// RED proof (pre-fix): assertion 3 fails — after reading and leaving the query
// the badge still reads "1", because the leave-settle cursor landed on
// `azzurra I973Peer` while the memo kept asking `azzurra i973peer`. Assertion 5
// then reads "2" instead of "1", which is the monotonic growth vjt reported.
//
// The peer nick is deliberately MIXED CASE — that is the whole bug. A
// lowercase peer would fold to itself and the spec would pass on broken code.
// bahamut preserves nick casing, and `IrcPeer` reconciles `peer.nick` from the
// authoritative 001 (#604), so every locator below is derived from the nick
// the server actually registered, never from the constant we asked for.

import {
  loginAs,
  selectChannel,
  sidebarMessageBadge,
  waitForDmListenerReady,
} from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specLiveNick, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const SERVER_WINDOW = "Server";
const PEER_NICK = "I973Peer";
const FIRST_DM = "issue-973 first dm";
const SECOND_DM = "issue-973 second dm";

// The spec focuses #spec-wN (advancing its cursor on leave). Restore it to tail so
// downstream specs inherit a clean at-tail cursor (BUGHUNT-3 cascade rule).
test.afterEach(async () => {
  const vjt = specUser();
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
});

test("#973 — a mixed-case query window's unread badge clears on read and stays clear", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Channel-first focus so the boot chain is fully evaluated, then await the
  // own-nick DM-listener subscribe: without it the peer's PRIVMSG below
  // fan-outs to zero subscribers and the query window never auto-opens
  // (FLAKE-D — same guard as CP14 B3).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await waitForDmListenerReady(page, NETWORK_SLUG);

  // Sit on the Server window: a query window's badge is only observable while
  // it is not the selected one, and Server has no compose, so it cannot
  // produce client chatter that races the assertions.
  await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW, { awaitWsReady: false });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  const nick = peer.nick;
  try {
    // 1. Inbound DM auto-opens the query window and puts one on the badge.
    peer.privmsg(await specLiveNick(), FIRST_DM);
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, nick)).toHaveText("1", {
      timeout: 10_000,
    });

    // 2. Read it. Waiting on the rendered line — not the tab click — is what
    //    makes the following leave-settle meaningful: the cursor advances over
    //    rows the pane actually showed.
    await selectChannel(page, NETWORK_SLUG, nick);
    await expect(
      page
        .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
        .filter({ hasText: FIRST_DM }),
    ).toBeVisible({ timeout: 10_000 });

    // Leave — the settle write advances the server-owned cursor over what was
    // read. Back on Server the query's badge is observable again.
    await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW, { awaitWsReady: false });

    // 3. THE #973 ASSERTION — reading cleared it. Pre-fix the settle landed on
    //    the raw key, the memo kept reading the folded one, and this stayed "1".
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, nick)).toHaveCount(0, {
      timeout: 10_000,
    });

    // 4. A second DM arrives while the operator is away. The badge counts it —
    //    the fix must not have silenced the window, only unstuck the cursor.
    peer.privmsg(await specLiveNick(), SECOND_DM);

    // 5. Exactly "1", not "2". This is the monotonic growth from the report:
    //    with the cursor stuck, the first (already-read) DM was still being
    //    counted, so the second arrival read "2". A spec that only checked
    //    "badge is present" would pass on the broken code.
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, nick)).toHaveText("1", {
      timeout: 10_000,
    });

    // 6. Reading again clears it again — the cursor keeps moving, it did not
    //    just happen to be right once.
    await selectChannel(page, NETWORK_SLUG, nick);
    await expect(
      page
        .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
        .filter({ hasText: SECOND_DM }),
    ).toBeVisible({ timeout: 10_000 });
    await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW, { awaitWsReady: false });

    await expect(sidebarMessageBadge(page, NETWORK_SLUG, nick)).toHaveCount(0, {
      timeout: 10_000,
    });
  } finally {
    await peer.disconnect("973 witness done");
  }
});
