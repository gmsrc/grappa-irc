// #1047 — `$N-` alias placeholder ("argument N and everything after it"),
// e2e.
//
// The unit layer (src/__tests__/slashCommands.test.ts) pins the grammar table:
// collapsed-token join, out-of-range → empty, `$1-` vs `$*` spacing, the
// greedy dash. This spec proves the thing a user actually reports: the
// canonical `alias k kick $1 $2-` produces a KICK whose reason arrives WHOLE
// at the far end of the wire — not a function returning a string.
//
// Pre-#1047 the same alias substituted `$2` and left the `-` behind, so the
// reason shipped as "get-" (first word plus a literal dash). The oracle is
// therefore doubly discriminating: the peer's inbound KICK line must carry
// every word of a multi-word reason.
//
// TWO oracles, deliberately:
//   1. UPSTREAM TRUTH — the kicked peer witnesses the raw KICK wire-line with
//      the full reason. Nothing client-side can fake this: bahamut relayed it.
//   2. CIC SURFACE — the kick row renders in scrollback with the same reason.
//
// vjt must be chanop to KICK, so vjt is the FOUNDING joiner of a fresh
// per-run channel (the testnet bahamut auto-ops the creator — same premise
// cp15-b6 relies on, with the roles swapped). The peer joins second.
//
// SINGLE subject arm (vjt), justified as in #385: alias expansion is
// client-side and subject-agnostic; there is no subject-shaped branch here.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL, partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const NEW_CHANNEL = `#i1047-${crypto.randomUUID().slice(0, 8)}`;
// Multi-word ON PURPOSE: `$2` alone would truncate it to "reaching" and leave
// a literal dash. Every word below has to survive.
const REASON = "reaching for the whole tail";

test.setTimeout(90_000);

let peer: IrcPeer | null = null;

// The durable per-subject alias map has no DELETE — PUT the empty map (the
// "clear all" shape, as #385's spec does).
const clearAliases = (token: string): Promise<unknown> =>
  fetch(`${GRAPPA_BASE_URL}/me/settings/aliases`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ aliases: {} }),
  }).catch(() => {});

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("e2e cleanup").catch(() => {});
    peer = null;
  }
  const vjt = specUser();
  await clearAliases(vjt.token);
  await partChannel(vjt.token, NETWORK_SLUG, NEW_CHANNEL).catch(() => {});
});

test("#1047 — `alias k kick $1 $2-` kicks with the WHOLE reason, upstream-witnessed", async ({
  page,
}) => {
  const vjt = specUser();
  await clearAliases(vjt.token);
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });

  // vjt founds the channel → bahamut grants @ (needed to KICK).
  await composeSend(page, `/join ${NEW_CHANNEL}`);

  // Gate on WS truth, not on the sidebar row: the self-JOIN scrollback line
  // means the JOIN echo landed AND the new window took focus (so the /k below
  // resolves its channel from the right window).
  await expect(
    page
      .locator('[data-testid="scrollback-line"][data-kind="join"]')
      .filter({ hasText: specNick() })
      .filter({ hasText: NEW_CHANNEL })
      .first(),
  ).toBeVisible({ timeout: 15_000 });

  // Peer joins second (no ops). Waiting for its row in the members pane is
  // the barrier that keeps the KICK from racing bahamut's JOIN handshake —
  // a kick issued too early answers 401 nosuchnick and never reaches anyone.
  peer = await IrcPeer.connect({ nick: `i1047-${crypto.randomUUID().slice(0, 6)}` });
  await peer.join(NEW_CHANNEL);
  const membersPane = page.locator(".members-pane");
  await expect(membersPane.locator("li", { hasText: peer.nick })).toBeVisible({ timeout: 15_000 });

  // Define the alias the issue is named after. The green notice is the
  // round-trip barrier: the server stored it AND the store mirrored it, so
  // the next send's expander can see it.
  await composeSend(page, "/alias k kick $1 $2-");
  const notice = page.locator(".compose-box-notice");
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await expect(notice).toContainText("/k");

  // Arm the upstream witness BEFORE sending — waitForLine attaches its
  // listener synchronously, and the KICK can land inside a millisecond.
  const kickLine = peer.waitForLine(
    new RegExp(`KICK ${NEW_CHANNEL} ${peer.nick} :${REASON}`),
    `KICK ${NEW_CHANNEL} carrying the whole reason`,
    15_000,
  );

  await composeSend(page, `/k ${peer.nick} ${REASON}`);

  // ORACLE 1 — upstream truth. Pre-#1047 this line read `:reaching-`.
  const raw = await kickLine;
  expect(raw).toContain(REASON);

  // ORACLE 2 — the cic surface renders the same whole reason.
  await expect(
    page.locator('[data-testid="scrollback-line"][data-kind="kick"]').filter({ hasText: REASON }),
  ).toBeVisible({ timeout: 10_000 });
});
