// #386 — ban management UX, proven end-to-end against the live upstream.
//
// Two conveniences, two witnesses:
//
//  1. The BanlistModal (the interactive `/banlist` surface that superseded
//     the #376 inline card). An op opens it, ADDs a ban BY NICK via the mask
//     builder (host form → the on-demand `resolve_userhost` lookup builds
//     `*!*@<host>` from the peer's cached userhost), sees it listed with the
//     setter, then REMOVEs it in one click and sees it gone. This drives the
//     full path: resolve_userhost → buildBanMask → MODE +b → 367/368 fold →
//     store → modal render (so it also subsumes #376's fold coverage), then
//     MODE -b → re-query. A hollow "modal opens" check would pass without any
//     of that; asserting the mask + setter + its removal proves it ran.
//
//  2. `/kb <nick>` kickban. A real peer joins; the op `/kb`s it. The peer
//     witnesses BOTH wire effects — MODE +b (`*!*@<host>`) then the KICK —
//     and disappears from the operator's members pane. Ban-first-then-kick,
//     both attempted (vjt decisions #1/#4).
//
// vjt creates a fresh per-run channel (→ sole op, so +b/KICK are allowed) and
// PARTs it in `finally`. A synthetic `IrcPeer` supplies the ban/kick target
// (and, by JOINing, seeds its `nick!user@host` into vjt's session
// userhost_cache — the host source `resolve_userhost` serves). jsdom/vitest
// cannot do this: it needs the live ircd MODE/KICK + 367/368 round-trip.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("#386 — banlist modal: add a ban by nick (mask builder), see it, remove it", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const channel = `#t386m-${Date.now()}`;
  const peer = await IrcPeer.connect({ nick: `bl386-${Date.now() % 1_000_000}` });

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  try {
    // vjt creates the channel → becomes op (@) → +b/-b are allowed.
    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });

    // Peer joins → grappa sees `:peer!user@host JOIN` and caches its userhost.
    // Waiting for the peer to render in the members pane proves that JOIN was
    // processed (so the on-demand resolve_userhost lookup will hit).
    await peer.join(channel);
    await expect(page.locator(".members-pane .member-name", { hasText: peer.nick })).toBeVisible({
      timeout: 15_000,
    });

    // Open the modal (the /banlist surface) and add a ban BY NICK — default
    // "host" form → resolve_userhost(peer) → *!*@<peerhost>.
    await composeSend(page, "/banlist");
    const modal = page.getByTestId("banlist-modal");
    await expect(modal).toBeVisible({ timeout: 15_000 });

    // WAIT for the open /banlist query to SETTLE (fresh channel → empty list)
    // BEFORE mutating. Two /banlist queries overlapping on the same channel is
    // a protocol-inherent race — 367/368 carry no request-id, so the first
    // query's 368 deletes the `banlist_pending` marker the second query's 367
    // needs, dropping the added ban from the store. Real latency serialises
    // the two (open completes in ~100ms, long before a human types + clicks);
    // bahamut's artificial per-connection fake-lag under full-suite load does
    // NOT, so serialise here explicitly. See DESIGN_NOTES 2026-07-25 #386.
    await expect(modal).toContainText("no bans set on", { timeout: 15_000 });

    await page.getByTestId("banlist-add-input").fill(peer.nick);
    await page.getByTestId("banlist-add-btn").click();

    // The list re-queries after the add and renders the host-form mask + the
    // setter (vjt) — the fields the #376 fold carries end-to-end. This waits
    // on TWO upstream frames (MODE +b, then the 367/368 re-query), each
    // subject to bahamut's per-connection fake-lag; 20s is headroom over the
    // ~10s bank cap the ircClient's 15s single-frame ceiling cites — a
    // condition-wait ceiling, resolved the instant the row lands, NOT a sleep.
    const mask = modal.locator(".banlist-modal-mask");
    await expect(mask).toContainText("*!*@", { timeout: 20_000 });
    await expect(modal).toContainText("set by");
    await expect(modal).toContainText(NETWORK_NICK);

    // Remove it in one click → MODE -b → re-query → the row is gone (two more
    // fake-lag-subject upstream frames — same 20s ceiling rationale).
    await modal.getByTestId("banlist-remove-btn").first().click();
    await expect(modal.getByTestId("banlist-remove-btn")).toHaveCount(0, { timeout: 20_000 });

    // Close the modal so the compose textarea is actionable for cleanup.
    await modal.getByRole("button", { name: "close ban list" }).click();
    await expect(modal).toHaveCount(0);
  } finally {
    await peer.disconnect("bye").catch(() => {});
    await composeSend(page, `/part ${channel}`).catch(() => {});
  }
});

test("#386 — /kb <nick> bans (*!*@host) then kicks — the peer witnesses both", async ({ page }) => {
  const vjt = getSeededVjt();
  const channel = `#t386kb-${Date.now()}`;
  const peer = await IrcPeer.connect({ nick: `kb386-${Date.now() % 1_000_000}` });

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  try {
    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });

    await peer.join(channel);
    await expect(page.locator(".members-pane .member-name", { hasText: peer.nick })).toBeVisible({
      timeout: 15_000,
    });

    // Arm both wire witnesses BEFORE the /kb: ban FIRST (`*!*@host`), then the
    // KICK — two frames, both attempted (vjt decisions #1/#4).
    const sawBan = peer.waitForLine(
      new RegExp(`MODE ${escapeRe(channel)} \\+b \\*!\\*@`),
      "MODE +b *!*@host",
      15_000,
    );
    const sawKick = peer.waitForLine(
      new RegExp(`KICK ${escapeRe(channel)} ${escapeRe(peer.nick)}`),
      "KICK peer",
      15_000,
    );

    await composeSend(page, `/kb ${peer.nick} begone`);

    await sawBan;
    await sawKick;

    // Visible cic outcome: the kicked peer leaves the operator's members pane.
    await expect(page.locator(".members-pane .member-name", { hasText: peer.nick })).toHaveCount(
      0,
      {
        timeout: 15_000,
      },
    );
  } finally {
    await peer.disconnect("bye").catch(() => {});
    await composeSend(page, `/part ${channel}`).catch(() => {});
  }
});
