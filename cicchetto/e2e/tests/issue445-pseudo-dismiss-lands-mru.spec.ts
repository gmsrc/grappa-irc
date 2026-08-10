// #445 — where focus lands when a greyed pseudo-row is dismissed with ×.
//
// #71 INC-3 unified the pseudo-row × behind one verb (`dismissPseudoWindow`)
// and, to keep the desktop behaviour byte-identical, kept the Sidebar's
// explicit redirect to the network `$server` window. It recorded the target
// itself as an open product question, because every OTHER window close in
// the app — /part, a server-side kick, the /disconnect cascade, a query
// close — lands on the most-recently-viewed window via selection.ts's
// bucket-E close-watcher. vjt ruled MRU (issue #445, 2026-08-07).
//
// MRU is not a different redirect, it is one fewer: the verb stops
// pre-empting the watcher that already owns every other close target.
//
// WHY AN E2E, AND WHY THIS FILE EXISTS AT ALL: the landing is a
// COMPOSITION of three parties that no unit can hold at once — the ×
// dropping the windowState key, the server's PART cleanup, and the
// watcher's live-window scan across channelsBySlug + queryWindowsByNetwork
// + windowStateByChannel. jsdom sees the first and the third with the
// second mocked. #902 deleted `issue71-inc3-bottombar-invite.spec.ts`, the
// only e2e that had ever pinned a pseudo-row dismiss LANDING, and recorded
// the deletion as a real coverage loss in its commit message; this file
// takes that coverage back at the `:failed` shape, which — unlike the
// `:invited` one #902 retired — still exists.
//
// The pre-state assertion is load-bearing: `/join` focuses the channel it
// joins (compose.ts), so the rejected join leaves the greyed row FOCUSED.
// Without asserting that first, "focus is on the seed channel afterwards"
// is equally true of a run where focus never left the seed channel.
//
// Scope: desktop chromium. The rule is surface-independent by
// construction — one verb, and since #902 the mobile BottomBar renders no
// pseudo-rows at all, so there is no second surface left to diverge.
//
// CHANNEL CLEANUP: random per-run suffixes; afterEach has the peer quit.

import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const KEYED_A = `#i445-a-${crypto.randomUUID().slice(0, 8)}`;
const KEYED_B = `#i445-b-${crypto.randomUUID().slice(0, 8)}`;
const CHANNEL_KEY = "porco-dio";

let peer: IrcPeer | null = null;

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("e2e cleanup").catch(() => {});
    peer = null;
  }
});

test("#445 — dismissing a pseudo-row lands on the most-recently-viewed window, never $server", async ({
  page,
}) => {
  // Peer founds two +k channels (auto-opped on the testnet bahamut; see
  // cp15-b6-pending-to-failed-invite-only.spec.ts for the
  // NO_CHANOPS_WHEN_SPLIT rationale). Joining either without the key
  // earns a 475 → `{:join_failed, …}` → a `:failed` greyed pseudo-row.
  peer = await IrcPeer.connect({ nick: `i445-${crypto.randomUUID().slice(0, 6)}` });
  for (const ch of [KEYED_A, KEYED_B]) {
    await peer.join(ch);
    await peer.mode(ch, "+k", CHANNEL_KEY);
  }

  const vjt = specUser();
  await loginAs(page, vjt);

  // The seed channel is the MRU entry the dismissal must return to. Only
  // channel/query focus enters MRU (selection.ts bucket E), so viewing it
  // is what arms this whole spec.
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });
  await expect(sidebarWindow(page, NETWORK_SLUG, SEED_CHANNEL)).toHaveClass(/selected/, {
    timeout: 10_000,
  });

  const serverWindow = sidebarWindow(page, NETWORK_SLUG, NETWORK_SLUG);

  // ─── Arm 1: the dismissed row IS the focused window ───
  await composeSend(page, `/join ${KEYED_A}`);

  const rowA = sidebarWindow(page, NETWORK_SLUG, KEYED_A);
  // Gate on the typed `join_failed` having landed — `data-window-state`
  // is the discrete seam (`.sidebar-window-greyed` is shared by every
  // non-joined state, so it cannot tell `pending` from `failed`).
  await expect(rowA).toHaveAttribute("data-window-state", "failed", { timeout: 15_000 });
  // PRE-STATE: `/join` moved focus onto the row that just failed. This is
  // the exact case INC-3 sent to `$server`.
  await expect(rowA).toHaveClass(/selected/, { timeout: 10_000 });

  await rowA.locator(".sidebar-close").click();

  await expect(rowA).toHaveCount(0, { timeout: 10_000 });
  // The ruling: MRU. Pre-#445 this is `$server`, so both halves are said
  // out loud — the positive alone would also pass if focus went nowhere
  // and the seed row had merely stayed selected, and the negative alone
  // would pass on a landing at home.
  await expect(sidebarWindow(page, NETWORK_SLUG, SEED_CHANNEL)).toHaveClass(/selected/, {
    timeout: 10_000,
  });
  await expect(serverWindow).not.toHaveClass(/selected/);

  // ─── Arm 2: the dismissed row is NOT the focused window ───
  // A × on a row the operator is not looking at is housekeeping, not
  // navigation: focus must not move at all.
  await composeSend(page, `/join ${KEYED_B}`);

  const rowB = sidebarWindow(page, NETWORK_SLUG, KEYED_B);
  await expect(rowB).toHaveAttribute("data-window-state", "failed", { timeout: 15_000 });
  await expect(rowB).toHaveClass(/selected/, { timeout: 10_000 });

  // Navigate away; the greyed row stays in the sidebar, unfocused.
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });
  await expect(sidebarWindow(page, NETWORK_SLUG, SEED_CHANNEL)).toHaveClass(/selected/, {
    timeout: 10_000,
  });
  await expect(rowB).not.toHaveClass(/selected/);

  await rowB.locator(".sidebar-close").click();

  await expect(rowB).toHaveCount(0, { timeout: 10_000 });
  await expect(sidebarWindow(page, NETWORK_SLUG, SEED_CHANNEL)).toHaveClass(/selected/);
  await expect(serverWindow).not.toHaveClass(/selected/);
});
