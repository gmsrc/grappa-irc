// #71 INC-2 — permanent right rail (desktop). vjt R1 ruling: the right rail
// is a PERMANENT surface, decoupled from the collapsible members panel; the
// settings cog lives in it (the ActionCluster) and is reachable from EVERY
// window kind — home / server / list / mentions / admin — not just joined
// channels. `.shell-no-members` no longer DROPS the column; it narrows it to
// the thin cluster so the cog never disappears.
//
// Two desktop-visible guarantees a jsdom unit test proves structurally but
// only a real browser confirms against the live layout:
//   1. Guardrail 1 (non-regression): the NEW per-network Sidebar mentions row
//      and the EXISTING archive list COEXIST without the per-network grouping
//      rail forking. The mentions row is a direct <li> of the main network
//      <ul>, so it inherits the 2px `border-left` rail exactly like a channel
//      row; the archive <ul> shares `.sidebar-network-section` but is scoped
//      OUT (`:not(.sidebar-archive-list)`), so archived rows stay 0px. Both
//      must render together after a return-from-away bundle + a PART.
//   2. The cog is reachable in the permanent rail on a NON-channel window
//      (home), and clicking it opens the settings drawer (R1's "cog on every
//      window kind").
//
// Desktop-only (no `@webkit`) — the permanent rail + Sidebar ARE the desktop
// chrome. The mobile openers (paletto 3) are covered by
// issue71-inc2-mobile-rail-openers.spec.ts.

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL_A = AUTOJOIN_CHANNELS[0]; // #bofh — seeded autojoin
const CHANNEL_B = "#i71inc2"; // fresh channel joined for the away round-trip
const AWAY_REASON = "inc2 lunch";

// Per-invocation unique mention body suffix (see issue188's comment): `#bofh`
// is truncated+reseeded by `_vjtReset` but `#i71inc2` is NOT, so a constant
// body would let the scrollback-render wait match a STALE prior-iteration row
// and false-pass. A fresh runId makes each wait a true "the FRESH mention
// landed" precondition.
const mentionBody = (where: string, runId: string): string =>
  `${NETWORK_NICK} inc2 ping in ${where} ${runId}`;

test.setTimeout(90_000);

test.afterEach(async () => {
  // The guardrail test PARTs #bofh into the archive; restore the seed-joined
  // state so later specs keep working (mirrors issue71-inc1-sidebar-own-nick).
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL_A);
});

test.describe("#71 INC-2 — permanent right rail (desktop)", () => {
  test("cog reachable in the permanent rail on a NON-channel window (home)", async ({ page }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // Cold-load lands on home (non-channel, no members surface). R1: the rail
    // narrows via `.shell-no-members` but KEEPS the ActionCluster cog, so it's
    // visible and opens settings from here — the whole point of the permanent
    // rail (pre-INC-2 the cog lived in a chrome row that had no home path on
    // desktop after the row was slated for removal).
    const cog = page.locator(".shell-members [data-testid='action-cluster-cog']");
    await expect(cog).toBeVisible({ timeout: 10_000 });
    await cog.click();
    await expect(page.locator(".settings-drawer.open")).toBeVisible({ timeout: 5_000 });
  });

  test("guardrail 1 — mentions row carries the 2px rail; archived row stays 0px; both coexist", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    const runId = crypto.randomUUID().slice(0, 8);
    const peerNick = `i71inc2-peer-${runId}`;
    await loginAs(page, vjt);

    // Join both channels (subscribed + confirmed via the self-JOIN line).
    await selectChannel(page, NETWORK_SLUG, CHANNEL_A, { ownNick: NETWORK_NICK });
    await composeSend(page, `/join ${CHANNEL_B}`);
    await selectChannel(page, NETWORK_SLUG, CHANNEL_B, { ownNick: NETWORK_NICK });

    // Go away so the peer's PRIVMSGs aggregate into a mentions bundle.
    await composeSend(page, `/away ${AWAY_REASON}`);

    const peer = await IrcPeer.connect({ nick: peerNick });
    try {
      await peer.join(CHANNEL_A);
      await peer.join(CHANNEL_B);

      // Highlight in each channel; focus the target first so the live push
      // confirms the row persisted server-side before we unaway.
      await selectChannel(page, NETWORK_SLUG, CHANNEL_A, { awaitWsReady: false });
      peer.privmsg(CHANNEL_A, mentionBody("bofh", runId));
      await expect(
        scrollbackLine(page, "privmsg", `inc2 ping in bofh ${runId}`).first(),
      ).toBeVisible({ timeout: 10_000 });

      await selectChannel(page, NETWORK_SLUG, CHANNEL_B, { awaitWsReady: false });
      peer.privmsg(CHANNEL_B, mentionBody("i71inc2", runId));
      await expect(
        scrollbackLine(page, "privmsg", `inc2 ping in i71inc2 ${runId}`).first(),
      ).toBeVisible({ timeout: 10_000 });

      // Come back → server pushes `mentions_bundle` → the per-network Sidebar
      // mentions row surfaces (cic auto-focuses the mentions window, unmounting
      // the ComposeBox).
      await composeSend(page, "/away", { expectUnmount: true });

      const mentionsRow = page.getByTestId(`sidebar-mentions-row-${NETWORK_SLUG}`);
      await expect(mentionsRow).toBeVisible({ timeout: 10_000 });

      // The mentions row is a direct <li> of the main network <ul>, so it wears
      // the 2px grouping rail exactly like a channel row. Poll + re-query: the
      // sidebar re-renders on window-state WS events, and getComputedStyle on a
      // detached mid-swap node resolves to "".
      await expect
        .poll(
          async () =>
            await mentionsRow.evaluate((el) => getComputedStyle(el).borderLeftWidth).catch(() => ""),
          { timeout: 5_000, message: "mentions row should carry the 2px grouping rail" },
        )
        .toBe("2px");

      // PART #bofh (server-side REST, no compose needed — the mentions window
      // has no ComposeBox) → it lands in the archive <ul>, which shares
      // `.sidebar-network-section` but is scoped OUT of the rail rule.
      await partChannel(vjt.token, NETWORK_SLUG, CHANNEL_A);
      await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL_A)).toHaveCount(0, { timeout: 5_000 });

      const networkSection = page.locator(".sidebar-network-section", {
        has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
      });
      const archiveSection = networkSection.locator(
        'xpath=following-sibling::details[@class="sidebar-archive"][1]',
      );
      await archiveSection.locator("summary").click();
      await expect(archiveSection).toHaveAttribute("open", "");

      const archivedRow = archiveSection.locator("li.sidebar-archive-row", { hasText: CHANNEL_A });
      await expect(archivedRow).toHaveCount(1, { timeout: 5_000 });
      await expect
        .poll(
          async () =>
            await archivedRow
              .evaluate((el) => getComputedStyle(el).borderLeftWidth)
              .catch(() => ""),
          { timeout: 5_000, message: "archived row must NOT inherit the grouping rail" },
        )
        .toBe("0px");

      // Coexistence: the mentions row STILL carries the rail while the archive
      // row (both under the shared `.sidebar-network-section` class) does not —
      // the non-regression this guardrail exists to catch.
      await expect(mentionsRow).toBeVisible();
      await expect
        .poll(
          async () =>
            await mentionsRow.evaluate((el) => getComputedStyle(el).borderLeftWidth).catch(() => ""),
          { timeout: 5_000, message: "mentions row rail must survive the archive coexistence" },
        )
        .toBe("2px");
    } finally {
      await peer.disconnect("bye");
    }
  });
});
