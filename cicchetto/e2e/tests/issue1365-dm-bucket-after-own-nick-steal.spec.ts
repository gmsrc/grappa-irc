// issue 1365 — after we take a nick that an OPEN QUERY WINDOW already
// holds, a third party's inbound DM must land in THAT PARTY'S window and
// not in the self window.
//
// This is the browser witness #2264 shipped without. That PR's evidence is
// vitest against the socket mock: it proves the precedence rule decides the
// way we want inside `subscribe.ts`, and nothing more. The reported defect
// is a symptom on a live browser against a real stack — every inbound DM,
// from everybody, collapsing into one window — so a green off that platform
// is not coverage of it. This spec drives the real thing end to end.
//
// ## The mechanism it reproduces
//
// `subscribe.ts` has four possible claimants of a topic key, and exactly two
// can hold a NICK: the DM listener (which subscribes to the own-nick topic
// and re-keys each inbound row on its SENDER) and the query-window loop
// (which subscribes to each open query peer's topic and keys rows on the
// TOPIC). They contend for one key the moment our own nick becomes a nick a
// query window is already open on.
//
// Pre-#2264 the DM-listener effect ends its ownership block with
// `if (joined.has(key)) continue;`. On a rename it correctly RELEASES the key
// it held under the old nick, then finds the new key already taken by the
// query loop — so it returns, and the account is left with no DM listener on
// any topic at all. Every inbound DM is then served by the channel handler,
// which keys on the topic, and the topic is our own nick: one bucket for
// every sender.
//
// ## Why the assertion is the NEGATIVE one
//
// The obvious assertion — "the body shows up in the peer's window" — is
// MASKED, and would be green on both sides of the fix. An inbound DM is
// stored at `channel = fold(own_nick), dm_with = sender`, and the DM read key
// is `nick_fold(COALESCE(dm_with, channel))`, i.e. the SENDER. So selecting
// the peer's window fetches the row over REST and renders it correctly
// however the live push was routed. It is kept below as a delivery control
// and labelled as one — it proves the row exists and is attributed to the
// peer server-side; it does not discriminate.
//
// What the server can never mask is the SELF window. Its read key is our own
// nick, and the row's key is the sender, so the row is not in that window's
// REST page in either regime. If the body is in the self window's pane, it
// can only have got there by a mis-routed LIVE push. Hence:
//
//   RED pre-#2264:  the channel handler owns the own-nick topic, the row
//                   renders into the focused self window → count 1.
//   GREEN on main:  the DM listener wins the key and re-keys on the sender →
//                   the self window never sees it → count 0.
//
// The negative is asserted while the self window is still FOCUSED and before
// any window switch, deliberately: `loadInitialScrollback` runs on every
// select, and a switch away and back could re-seed the pane from REST and
// wipe the very evidence this asserts the absence of.
//
// ## The barrier in front of it
//
// A `toHaveCount(0)` is only worth anything if the row has had its chance to
// arrive. Two server-side barriers run first and hold in BOTH regimes:
// `assertMessagePersisted` (the row is in the DB, so the broadcast has been
// issued) and the peer's sidebar row appearing (the #422 auto-open's
// `query_windows_list` reached the browser). The message push and that
// broadcast travel the same socket, the auto-open follows the persist, so the
// second barrier implies the first push was already delivered and processed.
// That last step is INFERRED from the ordering, not measured — what actually
// establishes the barrier is the pre-#2264 run going RED on this assertion.
//
// ## Why a minted visitor, and a nick nobody holds
//
// The spec renames a session's LIVE nick, a destructive mutation of
// server-side identity, so it may not touch the shared vjt session (the #477
// class). It mints its own visitor at runtime instead of seeding one, so it
// adds nothing to the steady state that the leak-canary and user-cap specs
// assert after it, and it survives scoped runs and `--repeat-each`.
//
// The query window is opened on a GHOST nick — one nobody is holding —
// rather than on a live peer who then quits. Same contention (a query window
// whose key we go on to take), no nick-release race to lose. `/msg <ghost>`
// opens the window client-side and server-side; the 401 that comes back is
// irrelevant here and is CP13 S5's subject, not ours.

import {
  bootVisitorContext,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
  waitForDmListenerReady,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted, GRAPPA_BASE_URL, mintVisitor } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { expect, test } from "../fixtures/test";

// The production spelling, not the legacy `"Server"` alias six older specs
// carry. `sidebarWindow` maps both to the same `[data-window-name="$server"]`
// locator, so this costs nothing at runtime and makes the declaration a
// PINNABLE copy (`e2eConstantMirrors.test.ts` MIRRORS) rather than a seventh
// entry in `KNOWN_UNPINNED`, where the question "does `"Server"` mirror a live
// production string?" is still open. Here it is not a question: this spec
// wants the server window, and the server window is named by
// `SERVER_WINDOW_NAME`.
const SERVER_WINDOW = "$server";

// Local rather than imported: `waitForNetworkState` lives inline in
// issue260-sticky-network-tab.spec.ts too. Same shape, same `/networks`
// `connection_state` field.
async function waitForNetworkState(
  token: string,
  slug: string,
  state: string,
  attempts = 60,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${GRAPPA_BASE_URL}/networks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const rows = (await res.json()) as Array<{ slug: string; connection_state: string }>;
      if (rows.find((r) => r.slug === slug)?.connection_state === state) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForNetworkState: ${slug} never reached ${state}`);
}

// Sends a slash command through the compose box. Same helper as
// issue498-badge-follows-live-nick.spec.ts, which also drives `/nick`.
async function runCommand(
  page: Parameters<typeof selectChannel>[0],
  command: string,
): Promise<void> {
  await page.locator(".compose-box textarea").fill(command);
  await page.locator(".compose-box textarea").press("Enter");
}

// Deterministic "our live nick is now `nick`" gate: our own row in the
// focused channel's member list. The list re-renders on NICK, and the client
// has provably processed the rename by the time the new name is there —
// which is what the routing decision under test depends on.
async function expectOwnMember(
  page: Parameters<typeof selectChannel>[0],
  nick: string,
): Promise<void> {
  const membersPane = page.locator(".shell-members .members-pane");
  await expect(membersPane).toBeVisible({ timeout: 10_000 });
  await expect(membersPane.locator(".member-name", { hasText: nick })).toBeVisible({
    timeout: 10_000,
  });
}

test("issue 1365 — a third party's DM does not land in the self window after we take an open query's nick", async ({
  browser,
}) => {
  const runId = crypto.randomUUID().slice(0, 8);
  const ghostNick = `i1365g-${runId}`;
  const peerNick = `i1365p-${runId}`;
  const channel = `#i1365-${runId}`;
  const body = `i1365 inbound from a third party ${runId}`;

  const visitor = await mintVisitor(`i1365-${runId}`);
  const slug = visitor.network_slug;
  await waitForNetworkState(visitor.token, slug, "connected");

  const { ctx, page } = await bootVisitorContext(browser, {
    id: visitor.id,
    token: visitor.token,
    registered: false,
  });

  let peer: IrcPeer | undefined;
  try {
    // A channel to gate the rename on. It cannot itself contend for the
    // own-nick key: the channels loop is fed by `GET /channels`, whose
    // autojoin half is sigil-validated and whose live half is the members
    // map of channels we JOINed — neither can produce a bare nick.
    await selectChannel(page, slug, SERVER_WINDOW);
    await runCommand(page, `/join ${channel}`);
    await selectChannel(page, slug, channel, { ownNick: visitor.nick });
    await expectOwnMember(page, visitor.nick);

    // Pre-state 1 — the DM listener IS installed while we wear our original
    // nick. Its later silence is then a suppression and not a listener that
    // never started.
    await waitForDmListenerReady(page, slug);

    // Pre-state 2 — the QUERY loop owns the ghost nick's topic. This is the
    // contention the rename walks into; without this gate the spec could
    // rename before the query subscribe landed and test nothing.
    await runCommand(page, `/msg ${ghostNick} hi`);
    await expect(sidebarWindow(page, slug, ghostNick)).toHaveCount(1, { timeout: 15_000 });
    await waitForQueryWindowReady(page, slug, ghostNick);

    // Take the nick the query window is holding.
    await selectChannel(page, slug, channel);
    await runCommand(page, `/nick ${ghostNick}`);
    await expectOwnMember(page, ghostNick);

    // Focus the contended window, so a mis-routed live row renders into the
    // VISIBLE pane rather than into a background store.
    await selectChannel(page, slug, ghostNick);

    peer = await IrcPeer.connect({ nick: peerNick });
    peer.privmsg(ghostNick, body);

    // Barrier 1 — persisted, and attributed to the peer. Probing
    // `channel: peerNick` hits the DM aggregation (channel == peer OR
    // dm_with == peer), which is where an inbound row stored at
    // `channel = own_nick` lives.
    await assertMessagePersisted({
      token: visitor.token,
      networkSlug: slug,
      channel: peerNick,
      sender: peerNick,
      body,
    });

    // Barrier 2 — the #422 auto-open round-tripped to the browser. Server
    // -side, so it holds in both regimes.
    await expect(sidebarWindow(page, slug, peerNick)).toHaveCount(1, { timeout: 15_000 });

    // THE ASSERTION. The self window is focused and the row is not in its
    // REST page in either regime, so a hit here can only be a mis-routed
    // live push.
    await expect(
      scrollbackLine(page, "privmsg", body),
      "a third party's DM must not render into the self window",
    ).toHaveCount(0);

    // Delivery control, NOT a discriminator — green on both sides of the fix,
    // because selecting this window fetches the row over REST on the sender
    // key. It is here so that a vacuous pass of the assertion above (nothing
    // was delivered at all) cannot go unnoticed.
    await selectChannel(page, slug, peerNick);
    await expect(scrollbackLine(page, "privmsg", body)).toBeVisible({ timeout: 15_000 });
  } finally {
    await peer?.disconnect("i1365 done");
    await ctx.close();
  }
});
