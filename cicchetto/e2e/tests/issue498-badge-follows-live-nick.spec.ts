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
// ## Self-contained session (b-runtime, GH #498)
//
// The witness renames a session's LIVE nick — a destructive mutation of
// server-side identity — so it must never touch the shared vjt session (the
// #477-avoided destructive-on-shared-identity class). An earlier take
// boot-seeded a dedicated live session; that put an i498 session in the
// steady state that m9b (the leak canary) and u-z-cap (user-cap) assert
// AFTER it, reddening BOTH the full suite and scoped `--grep m9b` iso
// reruns (a fixture that only works at full-suite scope is not a fixture).
//
// So this spec is SELF-CONTAINED: it accretes its OWN session at runtime
// and parks it on teardown — surviving scoped runs, `--repeat-each`, and
// file reordering. bahamut-test is NOT visitor_enabled (no self-serve
// accretion), so it accretes `azzurra`, which is visitor_enabled AND points
// at the SAME leaf (bahamut-test:6667): the peer sees the session with no
// extra wiring, and i498 consumes NO bahamut-test user-cap slot (u-z-cap
// stays doubly safe). The anon accretion default nick is the account name
// (`i498-user` = `I498_NICK`), unique across the seeded set → no shared-leaf
// 433 autokill. The parked credential left on teardown has no live pid, so
// it is invisible to every Registry-based session/capacity count guard.

import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import {
  accreteNetwork,
  assertMessagePersisted,
  patchNetworkConnectionState,
  restoreReadCursorToTail,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import {
  getSeededI498User,
  I498_CHANNEL,
  I498_NETWORK_SLUG,
  I498_NICK,
} from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = I498_CHANNEL;
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

// Park the runtime-accreted azzurra session so it never sits in the steady
// state m9b (leak canary) + u-z-cap (user-cap) assert AFTER this spec, and
// so scoped `--grep m9b` reruns (where this spec never runs) start clean.
// Parked → drops from the live Registry (no pid); the residual :parked
// credential lands only on /admin/credentials, whose specs run before this
// one (a<i). Runs once after all `--repeat-each` iterations.
test.afterAll(async () => {
  const user = getSeededI498User();
  await patchNetworkConnectionState(user.token, I498_NETWORK_SLUG, {
    connection_state: "parked",
  });
});

test("#498 — a mention of the LIVE (renamed) nick lifts the server badge on cold-load", async ({
  page,
}) => {
  const user = getSeededI498User();
  const runId = crypto.randomUUID().slice(0, 8);
  const newNick = `i498-${runId}`;
  const seedBody = `#498 seed ${runId}`;
  const body = `${newNick}: ping while your socket is down`;

  // Self-contained session: accrete azzurra (204 first run; 409
  // already-attached is idempotent for --repeat-each) then ensure it is
  // LIVE. bahamut-test is not visitor_enabled; azzurra shares its leaf.
  await accreteNetwork(user.token, I498_NETWORK_SLUG);
  await patchNetworkConnectionState(user.token, I498_NETWORK_SLUG, {
    connection_state: "connected",
  });

  await loginAs(page, user);

  // Anon accretion autojoins nothing — join the witness channel at runtime.
  // Focus the server window first so the compose box is available.
  await selectChannel(page, I498_NETWORK_SLUG, SERVER_WINDOW);
  await runCommand(page, `/join ${CHANNEL}`);
  await selectChannel(page, I498_NETWORK_SLUG, CHANNEL, { ownNick: I498_NICK });
  await expectOwnMember(page, I498_NICK);

  const peer = await IrcPeer.connect({ nick: `i498p-${runId}` });
  try {
    await peer.join(CHANNEL);

    // Anchor the read cursor: BadgeCount skips windows with no cursor, and
    // restoreReadCursorToTail is a no-op on an empty channel. So the peer
    // seeds ONE non-mention row, we wait for it to persist, then pin the
    // cursor to it — making the mention below the ONLY post-cursor row.
    peer.privmsg(CHANNEL, seedBody);
    await assertMessagePersisted({
      token: user.token,
      networkSlug: I498_NETWORK_SLUG,
      channel: CHANNEL,
      sender: `i498p-${runId}`,
      body: seedBody,
    });
    await restoreReadCursorToTail(user.token, I498_NETWORK_SLUG, CHANNEL);

    // Rename. Gate on the member list showing the NEW nick — proof the
    // upstream NICK echo has been processed and the server's live nick (and
    // its registry copy) is now `newNick`.
    await runCommand(page, `/nick ${newNick}`);
    await expectOwnMember(page, newNick);

    // Defocus so CHANNEL is not the active window (its badge would be
    // focus-zeroed) and reload won't auto-read it.
    await selectChannel(page, I498_NETWORK_SLUG, SERVER_WINDOW, { awaitWsReady: false });
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
    peer.privmsg(CHANNEL, body);
    await assertMessagePersisted({
      token: user.token,
      networkSlug: I498_NETWORK_SLUG,
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
    // Restore this session's live nick to its credential nick so a
    // `--repeat-each` rerun starts from the baseline the opening
    // `expectOwnMember(I498_NICK)` asserts. Best-effort: the socket may be
    // down after a failure, so guard the UI-driven rename-back.
    try {
      await selectChannel(page, I498_NETWORK_SLUG, CHANNEL, { awaitWsReady: false });
      await runCommand(page, `/nick ${I498_NICK}`);
      await expectOwnMember(page, I498_NICK);
    } catch {
      // Leave restoration to the next reconnect (reconnect uses the
      // credential nick, which is still I498_NICK).
    }
    await peer.disconnect("i498 done");
  }
});
