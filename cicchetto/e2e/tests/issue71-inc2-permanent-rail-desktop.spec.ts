// #71 INC-2 — permanent right rail (desktop). vjt R1 ruling: the right rail
// is a PERMANENT surface, decoupled from the collapsible members panel; the
// settings cog lives in it (the ActionCluster) and is reachable from EVERY
// window kind — home / server / list / mentions / admin — not just joined
// channels. `.shell-no-members` no longer DROPS the column; it narrows it to
// the thin cluster so the cog never disappears.
//
// Two desktop-visible guarantees a jsdom unit test proves structurally but
// only a real browser confirms against the live layout:
//   1. Guardrail 1 (non-regression): the per-network Sidebar mentions row wears
//      the 2px grouping rail (it is a direct <li> of the main network <ul>, so
//      it inherits the `border-left` rail exactly like a channel row), and
//      PARTing a channel into the archive does NOT fork or drop that rail. #473
//      moved the archive OUT of the Sidebar into the grouped ArchiveModal, so
//      the archive <ul> no longer shares `.sidebar-network-section` (the old
//      rail rule needed a `:not(.sidebar-archive-list)` carve-out — both are
//      gone). The parted window is now reachable in the modal, and the sidebar
//      rail must survive its departure from the <ul>. Both must hold after a
//      return-from-away bundle + a PART.
//   2. The cog is reachable in the permanent rail on a NON-channel window
//      (home), and clicking it opens the settings drawer (R1's "cog on every
//      window kind").
//
// Desktop-only (no `@webkit`) — the permanent rail + Sidebar ARE the desktop
// chrome. The mobile openers (paletto 3) are covered by
// issue71-inc2-mobile-rail-openers.spec.ts.

import {
  composeSend,
  expandArchiveGroup,
  loginAs,
  openArchive,
  openRailMenu,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL_A = AUTOJOIN_CHANNELS[0]; // #spec-wN — seeded autojoin
const CHANNEL_B = "#i71inc2"; // fresh channel joined for the away round-trip
const AWAY_REASON = "inc2 lunch";

// Per-invocation unique mention body suffix (see issue188's comment): `#spec-wN`
// is truncated+reseeded by `_vjtReset` but `#i71inc2` is NOT, so a constant
// body would let the scrollback-render wait match a STALE prior-iteration row
// and false-pass. A fresh runId makes each wait a true "the FRESH mention
// landed" precondition.
const mentionBody = (where: string, runId: string): string =>
  `${specNick()} inc2 ping in ${where} ${runId}`;

test.setTimeout(90_000);

test.afterEach(async () => {
  // The guardrail test PARTs #spec-wN into the archive; restore the seed-joined
  // state so later specs keep working (mirrors issue71-inc1-sidebar-own-nick).
  const vjt = specUser();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL_A);
});

test.describe("#71 INC-2 — permanent right rail (desktop)", () => {
  test("cog reachable in the permanent rail on a NON-channel window (home)", async ({ page }) => {
    const vjt = specUser();
    await loginAs(page, vjt);

    // Cold-load lands on home (non-channel, no members surface). R1: the rail
    // narrows via `.shell-no-members` but KEEPS the ActionCluster cog, so it's
    // visible and opens settings from here — the whole point of the permanent
    // rail (pre-INC-2 the cog lived in a chrome row that had no home path on
    // desktop after the row was slated for removal).
    await openRailMenu(page);
    const cog = page.locator(
      ".shell-members .rail-actions-menu [data-testid='action-cluster-cog']",
    );
    await expect(cog).toBeVisible({ timeout: 10_000 });
    await cog.click();
    await expect(page.locator(".settings-drawer.open")).toBeVisible({ timeout: 5_000 });
  });

  test("guardrail 1 — mentions row carries the 2px rail; archived row stays 0px; both coexist", async ({
    page,
  }) => {
    const vjt = specUser();
    const runId = crypto.randomUUID().slice(0, 8);
    const peerNick = `i71inc2-peer-${runId}`;
    await loginAs(page, vjt);

    // Join both channels (subscribed + confirmed via the self-JOIN line).
    await selectChannel(page, NETWORK_SLUG, CHANNEL_A, { ownNick: specNick() });
    await composeSend(page, `/join ${CHANNEL_B}`);
    await selectChannel(page, NETWORK_SLUG, CHANNEL_B, { ownNick: specNick() });

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
            await mentionsRow
              .evaluate((el) => getComputedStyle(el).borderLeftWidth)
              .catch(() => ""),
          { timeout: 5_000, message: "mentions row should carry the 2px grouping rail" },
        )
        .toBe("2px");

      // PART #spec-wN (server-side REST, no compose needed — the mentions window
      // has no ComposeBox) → the channel leaves the main network <ul> and moves
      // into the archive (now the grouped ArchiveModal, #473 — no longer an
      // inline Sidebar `<details class="sidebar-archive">`).
      await partChannel(vjt.token, NETWORK_SLUG, CHANNEL_A);
      await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL_A)).toHaveCount(0, { timeout: 5_000 });

      // Coexistence — the non-regression this guardrail exists to catch: the
      // mentions row STILL carries its 2px grouping rail after the parted
      // channel left the <ul>. Moving a window into the archive must not fork or
      // drop the per-network grouping rail. Poll + re-query: the sidebar
      // re-renders on window-state WS events, and getComputedStyle on a
      // detached mid-swap node resolves to "".
      await expect(mentionsRow).toBeVisible();
      await expect
        .poll(
          async () =>
            await mentionsRow
              .evaluate((el) => getComputedStyle(el).borderLeftWidth)
              .catch(() => ""),
          { timeout: 5_000, message: "mentions row rail must survive the archive move" },
        )
        .toBe("2px");

      // The parted channel is reachable in the grouped ArchiveModal (#473 —
      // archive is one modal opened from the always-on RailActions button, not
      // the retired Sidebar `<details class="sidebar-archive">`). Expanding the
      // network's group triggers the lazy row load.
      const modal = await openArchive(page);
      await expect(modal).toBeVisible();
      const group = await expandArchiveGroup(page, NETWORK_SLUG);
      const archivedRow = group.locator(".archive-modal-row", { hasText: CHANNEL_A });
      await expect(archivedRow).toHaveCount(1, { timeout: 5_000 });
    } finally {
      await peer.disconnect("bye");
    }
  });
});
