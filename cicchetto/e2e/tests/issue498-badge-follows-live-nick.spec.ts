// #498 — the SERVER-computed notify/badge count follows the LIVE nick
// after a `/nick`, not the configured credential nick.
//
// This is a WIRING WITNESS, not the exhaustive proof. The two-halves
// behaviour (a mention of the NEW nick starts counting; a mention of the
// OLD nick stops) is proven deterministically in the Elixir
// `Grappa.Push.BadgeCountLiveNickTest`, free of browser masking. Here we
// prove the one thing ExUnit cannot: the fix is wired end-to-end through
// the real stack — a real rename, a real peer, a real cold-load.
//
// ## Why the OBVIOUS observables are masked (and this one is not)
//
// The per-channel WS snapshot (`grappa_channel` `push_channel_snapshot`)
// and the per-scrollback DM filter (`messages_controller`) ALREADY
// resolved own_nick via the live `Session.current_nick/2`, so a joined
// channel's sidebar `@n` mention badge is re-seeded LIVE on its join reply
// — it was already correct after a rename, GREEN before the fix. The
// client-side foreground title increment (`incrementBadge`) uses cic's own
// `ownNickForNetwork`, updated by `own_nick_changed` — also already
// correct. Asserting either would be green-on-both: useless.
//
// The ONLY surface that was WRONG is the GLOBAL badge (`BadgeCount.count`),
// seeded from the server at cold-load (`/me` `badge_count`) and mirrored to
// `document.title` as `(n) `. It has no per-channel live override. To
// isolate it from the client foreground bump we borrow #267's WS-gap trick:
// the mention lands while cic's socket is DOWN (no client bump possible),
// then a page reload cold-loads the count purely from the server.
//
//   RED before the fix:  server counts against the STALE configured nick →
//                        the NEW-nick mention is not counted → title badge
//                        does NOT increase.
//   GREEN after the fix: server counts against the LIVE nick → counted →
//                        title badge increases.
//
// ## Shared-session hygiene
//
// The rename mutates the SHARED seeded-vjt session's live nick, so the
// `finally` renames it back to `NETWORK_NICK` (and waits for the member
// list to confirm) to avoid poisoning sibling specs.

import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { assertMessagePersisted, restoreReadCursorToTail } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const SERVER_WINDOW = "Server";

// The leading `(n)` badge prefix the title mirror writes (0 if absent),
// read in the browser context. Same reader as `pwa-badge-title-mirror`.
const TITLE_BADGE = () => Number(document.title.match(/^\((\d+)\)/)?.[1] ?? "0");

// Sends a slash command through the compose box.
async function runCommand(page: Parameters<typeof loginAs>[0], command: string): Promise<void> {
  await page.locator(".compose-box textarea").fill(command);
  await page.locator(".compose-box textarea").press("Enter");
}

// Deterministic "the nick is now `nick`" gate: the operator's own row in
// the focused channel's member list. The member list re-renders on NICK,
// and `own_nick_changed` is broadcast AFTER the server has published the
// new live nick into the registry — so seeing it here guarantees the
// server-side count already resolves the new nick.
async function expectOwnMember(
  page: Parameters<typeof loginAs>[0],
  nick: string,
): Promise<void> {
  const membersPane = page.locator(".shell-members .members-pane");
  await expect(membersPane).toBeVisible({ timeout: 10_000 });
  await expect(membersPane.locator(".member-name", { hasText: nick })).toBeVisible({
    timeout: 10_000,
  });
}

test("#498 — a mention of the LIVE (renamed) nick lifts the server badge on cold-load", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const runId = crypto.randomUUID().slice(0, 8);
  const newNick = `i498-${runId}`;
  const body = `${newNick}: ping while your socket is down`;

  // Clean baseline: pin #bofh's cursor to the tail so the one mention below
  // is the ONLY post-cursor row it contributes to the global count.
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expectOwnMember(page, NETWORK_NICK);

  const peer = await IrcPeer.connect({ nick: `i498p-${runId}` });
  try {
    // Rename. Gate on the member list showing the NEW nick — proof the
    // upstream NICK echo has been processed and the server's live nick (and
    // its registry copy) is now `newNick`.
    await runCommand(page, `/nick ${newNick}`);
    await expectOwnMember(page, newNick);

    // Defocus so #bofh is not the active window (its badge would be
    // focus-zeroed) and reload won't auto-read it.
    await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW, { awaitWsReady: false });
    const before = await page.evaluate(TITLE_BADGE);

    // Drop + HOLD cic's socket so the mention below cannot trigger the
    // client-side foreground increment — the post-reload badge is then
    // provably 100% server-sourced.
    await page.evaluate(async () => {
      if (!window.__cic_dropSocketForTests) {
        throw new Error("__cic_dropSocketForTests hook missing");
      }
      await window.__cic_dropSocketForTests();
    });
    await page.waitForFunction(() => window.__cic_socketHealth?.state().state !== "open");

    // Peer mentions the NEW nick while cic is confirmed offline.
    await peer.join(CHANNEL);
    peer.privmsg(CHANNEL, body);
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: CHANNEL,
      sender: `i498p-${runId}`,
      body,
    });

    // Cold-load: a fresh page boot re-fetches `/me`, whose `badge_count` is
    // the server `BadgeCount.count` — no client state survives the reload,
    // so the title badge is purely server-sourced.
    await page.reload();
    await expect(page.locator(".compose-box textarea")).toBeVisible({ timeout: 30_000 });

    // The server counted the NEW-nick mention → the badge rose. RED before
    // the fix: the server matched the stale configured nick, so
    // `newNick: …` was not a mention and the badge stayed flat.
    await expect
      .poll(() => page.evaluate(TITLE_BADGE), {
        message: "server badge_count should rise after a mention of the live (renamed) nick",
        timeout: 30_000,
      })
      .toBeGreaterThan(before);
  } finally {
    // Restore the shared session's live nick so sibling specs still see
    // NETWORK_NICK. Best-effort: the socket may be down after a failure, so
    // guard the UI-driven rename-back.
    try {
      await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });
      await runCommand(page, `/nick ${NETWORK_NICK}`);
      await expectOwnMember(page, NETWORK_NICK);
    } catch {
      // Leave restoration to the next reconnect (reconnect uses the
      // credential nick, which is still NETWORK_NICK).
    }
    await peer.disconnect("i498 done");
  }
});

declare global {
  interface Window {
    __cic_dropSocketForTests?: () => Promise<void>;
    __cic_socketHealth?: {
      state: () => { state: string };
    };
  }
}
