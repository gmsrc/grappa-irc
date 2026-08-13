// #1262 — channel MODE rows fold into the denoise filter, own-nick mode rows
// on `$server` do not.
//
// `:mode` was carved OUT of the suppressed set by #458 on the rule "the broad
// presence/control kinds carry operator-relevant signal and MUST stay
// visible". vjt withdrew that rule on 2026-08-13, so `:mode` is now the fifth
// plain kind in `Grappa.Scrollback.Message.suppressed_presence_kinds/0` and in
// cic's `SUPPRESSED_PRESENCE_KINDS`.
//
// ## What this e2e owns vs what the unit tests own
//
// The SET membership is pinned in `test/grappa/scrollback/message_test.exs` and
// `src/__tests__/presenceFilter.test.ts`, and the two languages are held equal
// by the parser gate in `test/grappa/presence_filter_test.exs`. The `$server`
// resolve-to-SHOW rule is pinned in
// `test/grappa/presence_filter/resolver_test.exs`. None of those can see the
// VISIBLE outcome, which is what this spec owns:
//
//   1. a channel MODE row renders, then DISAPPEARS the moment the channel is
//      denoised (the cic render filter), and
//   2. it is still gone after a RELOAD — i.e. the SERVER omitted it from the
//      cold-load page, not merely cic hiding it. This is the half that would
//      regress if only one side of the mirror moved; and
//   3. the own-nick `$server` mode row SURVIVES the same reload, because
//      `$server` has no member count and resolves to SHOW.
//
// A content row rides along throughout as the load witness: it proves the
// page is populated, so "0 mode rows" means folded rather than "nothing
// loaded yet" (an empty pane would satisfy the mode assertion vacuously).
//
// ## Why the spec creates its own channel
//
// `/join` on a fresh name makes the seeded user the channel creator, hence
// chanop, hence able to set `+m` — the same trick #240 uses for the mode
// modal. On a shared autojoin channel the user may not be op, and bahamut
// only echoes a MODE it actually applied, so a non-op attempt would hang to
// timeout rather than fail (feedback: the witness must be SERVED by the ircd).
//
// Anti-hollow-green: `/umode -i` in `finally` restores the shared seeded
// session's umode set so sibling specs do not inherit `+i` (mirrors #229).
//
// Desktop project (untagged → chromium; NO @webkit).

import { composeSend, loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test.setTimeout(90_000);

test("#1262 — a channel MODE row folds when denoised (server-side too), the $server umode row stays", async ({
  page,
}) => {
  const vjt = specUser();
  const channel = `#t1262-${Date.now()}`;
  const content = `issue1262-content-${Date.now()}`;

  await loginAs(page, vjt);
  // Focus the autojoin channel first to confirm login + WS-ready before
  // issuing the /join (mirrors #240 / issue216 boot order).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  try {
    // --- the $server half: an own-nick umode row -------------------------
    // Issued BEFORE the channel work so it is comfortably persisted by the
    // time the reload below re-reads $server from the server.
    await composeSend(page, "/umode +i");

    // --- a channel where we are op --------------------------------------
    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });

    // Content witness first, then the MODE. Same socket ⇒ ordered.
    await composeSend(page, content);
    await composeSend(page, `/mode ${channel} +m`);

    const contentRow = page
      .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
      .filter({ hasText: content });
    const modeRows = page.locator('[data-testid="scrollback-line"][data-kind="mode"]');

    // Baseline: unset pref on a 1-member channel → presence SHOWN, so the
    // mode row renders. Without this the "0 rows" below proves nothing.
    await expect(contentRow).toHaveCount(1, { timeout: 15_000 });
    await expect(modeRows.first()).toBeVisible({ timeout: 15_000 });

    // --- denoise: the render filter drops it -----------------------------
    // Await the persist PUT before reloading — the cold-load resolves
    // hide_presence from the PERSISTED pref, so an in-flight PUT would race
    // an unfiltered fetch (the #458 lesson).
    await openRailMenu(page);
    const toggle = page.locator('[data-testid="presence-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    const hidePut = page.waitForResponse(
      (r) =>
        r.url().includes("/me/settings/display-prefs") && r.request().method() === "PUT" && r.ok(),
    );
    await toggle.click();
    await hidePut;

    await expect(modeRows).toHaveCount(0, { timeout: 10_000 });
    await expect(contentRow).toHaveCount(1); // a filter, not a blanket drop

    // --- THE SERVER HALF: the cold-load PAGE arrives without the mode row -
    //
    // Asserted on the RESPONSE BODY, not on the pane. Measured, because the
    // first shape of this arm did the latter and was VACUOUS: with only
    // `message.ex` reverted and cic's own filter intact, the render filter
    // hides the row the server still sends, so the pane shows 0 either way
    // and the spec passed with the server defect fully present. A server-only
    // mutant survived it; that is what promoted this from a DOM count to a
    // wire assertion. The pane count below stays as the operator-visible
    // half, but it is the JSON that speaks for the server.
    // The path must be ANCHORED, not `includes`-matched: the cold load also
    // issues `/messages/count`, whose URL contains `/messages` and whose body
    // is `{count: N}` — an object with no `.some`. Measured, not foreseen: the
    // loose predicate matched it first and the arm died on a TypeError.
    // EVERY such response is collected, not just the first one awaited. The
    // first shape awaited a single response and read an array with no privmsg
    // in it — the cold load issues more than one GET for a channel, and which
    // one carries the rows is not something this spec should be pinning. The
    // claim is about what the server served for this channel, so the subject
    // is the UNION of what it served.
    const servedPages: { kind: string }[][] = [];
    page.on("response", (r) => {
      if (
        r.request().method() !== "GET" ||
        r.status() !== 200 ||
        !new URL(r.url()).pathname.endsWith(`/channels/${encodeURIComponent(channel)}/messages`)
      ) {
        return;
      }
      // `GET .../messages` answers a BARE ARRAY (api.ts's `fetchMessages`),
      // not an envelope. Anchored on the path because `/messages/count`
      // answers `{count: N}` and an `includes` match ate it first.
      void r
        .json()
        .then((body) => {
          if (Array.isArray(body)) servedPages.push(body as { kind: string }[]);
        })
        .catch(() => {});
    });

    await page.reload();
    await selectChannel(page, NETWORK_SLUG, channel, { awaitWsReady: false });

    // DOM barrier FIRST: the content row being back is the durable signal
    // that the cold load has actually landed. Reading the collected pages
    // before it would race the fetches still in flight.
    await expect(contentRow).toHaveCount(1, { timeout: 15_000 });
    await expect(modeRows).toHaveCount(0);

    const served = servedPages.flat();
    // Non-vacuity, twice over: a page set that was never populated, or one
    // that carried nothing, would satisfy "no mode row" for the wrong reason.
    expect(servedPages.length).toBeGreaterThan(0);
    expect(served.some((m) => m.kind === "privmsg")).toBe(true);
    expect(served.filter((m) => m.kind === "mode")).toEqual([]);

    // --- $server is NOT denoised by the channel's pin ---------------------
    // The pin is per-channel (`"<slug> <channel>"`), and `$server` has no
    // member count, so `PresenceFilter.hidden?/2` reads the unknowable count
    // as SHOW. The own-nick `+i` row must therefore survive the same
    // cold-load that just dropped the channel's mode row — this is the
    // #154(b) confirmation the operator relies on.
    await selectChannel(page, NETWORK_SLUG, "$server", { awaitWsReady: false });
    const serverModeRows = page.locator('[data-testid="scrollback-line"][data-kind="mode"]');
    await expect(serverModeRows.first()).toBeVisible({ timeout: 15_000 });
  } finally {
    await composeSend(page, "/umode -i").catch(() => {});
  }
});
