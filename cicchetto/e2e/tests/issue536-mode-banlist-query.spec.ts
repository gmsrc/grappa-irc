// #536 — `/mode #chan +b` (the list-mode QUERY form of /mode) must open the
// banlist, proven end-to-end against the live upstream.
//
// The bug: a ban list requested via raw MODE was silently swallowed. The 367
// RPL_BANLIST replies arrive from the ircd, but grappa's accumulator only
// folds them when `banlist_pending` is primed — and that marker is set ONLY by
// the `/banlist` slash command. So `/mode #chan +b` executed a raw MODE whose
// 367/368 reply was dropped, and the user saw nothing (no rows, no modal). The
// fix maps the list-mode query shape onto the /banlist path in the parser.
//
// This asserts the USER-VISIBLE outcome — the ban RENDERS in the modal opened
// by `/mode #chan +b` — not that a numeric merely arrived. Two shapes, one
// witness each:
//
//   * MUTATION (mask present): `/mode #chan +b <mask>` still executes a raw
//     MODE +b. A synthetic peer in the channel witnesses the wire line, which
//     also serialises "the ban landed" before the query fires (367s carry no
//     request-id, so we must not race the +b against the re-query).
//   * QUERY (no mask): `/mode #chan +b` opens the BanlistModal (the #386
//     surface) and re-queries — the added mask, its setter, and the remove
//     control render, exactly as `/banlist` would.
//
// jsdom/vitest cannot do this: it needs the live ircd MODE + 367/368 round
// trip. vjt creates a fresh per-run channel (→ sole op, so +b is allowed) and
// PARTs it in `finally`.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("#536 — /mode #chan +b opens the banlist and renders the ban (query form)", async ({
  page,
}) => {
  const vjt = specUser();
  const channel = `#t536mb-${Date.now()}`;
  // A literal mask — no peer resolve needed; the peer here is only a wire
  // witness that the +b landed before we query.
  const banMask = `naughty536-${Date.now() % 1_000_000}!*@*`;
  const peer = await IrcPeer.connect({ nick: `mb536-${Date.now() % 1_000_000}` });

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  try {
    // vjt creates the channel → becomes op (@) → +b is allowed.
    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });

    // Peer joins so it receives the channel MODE broadcast.
    await peer.join(channel);
    await expect(page.locator(".members-pane .member-name", { hasText: peer.nick })).toBeVisible({
      timeout: 15_000,
    });

    // MUTATION form: `/mode #chan +b <mask>` (mask present) still executes a
    // raw MODE +b — unchanged by #536. Arm the wire witness first, then send;
    // awaiting it proves the ban is registered upstream BEFORE the query fires
    // (serialises the two, avoiding the 367-after-368 overlap the marker race
    // creates — see #386 DESIGN_NOTES 2026-07-25).
    const sawBan = peer.waitForLine(
      new RegExp(`MODE ${escapeRe(channel)} \\+b ${escapeRe(banMask)}`),
      "MODE +b <mask>",
      15_000,
    );
    await composeSend(page, `/mode ${channel} +b ${banMask}`);
    await sawBan;

    // QUERY form: `/mode #chan +b` (no mask) is the #536 fix — it opens the
    // BanlistModal (same surface as /banlist) and re-queries. The added mask +
    // setter render; a raw-MODE-that-drops-367s would show an empty modal.
    // Two upstream frames land on open (the query MODE, then the 367/368 fold),
    // each subject to bahamut's per-connection fake-lag — 20s condition-wait
    // ceiling, resolved the instant the row lands, NOT a sleep.
    await composeSend(page, `/mode ${channel} +b`);
    const modal = page.getByTestId("banlist-modal");
    await expect(modal).toBeVisible({ timeout: 15_000 });

    const mask = modal.locator(".banlist-modal-mask");
    await expect(mask).toContainText(banMask, { timeout: 20_000 });
    await expect(modal).toContainText("set by");
    await expect(modal).toContainText(specNick());

    // Close the modal so the compose textarea is actionable for cleanup.
    await modal.getByRole("button", { name: "close ban list" }).click();
    await expect(modal).toHaveCount(0);
  } finally {
    await peer.disconnect("bye").catch(() => {});
    await composeSend(page, `/part ${channel}`).catch(() => {});
  }
});
