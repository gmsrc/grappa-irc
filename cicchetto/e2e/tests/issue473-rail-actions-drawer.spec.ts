// #473 — the RailActions drawer + the grouped ArchiveModal, end to end.
//
// #473 folded EVERY rail affordance into ONE `.rail-actions` drawer pinned at
// the bottom of `.shell-members`, mounted (unchanged) on BOTH desktop and
// mobile and on EVERY window kind. It superseded the two split surfaces the
// post-#71 rail rework left behind (the top ActionCluster cog + the mobile-only
// `.mobile-panel-actions` footer) AND retired the three archive doors (desktop
// Sidebar `<details class="sidebar-archive">`, the mobile footer chip, and the
// ShellChrome `shell-chrome-archive` button) in favour of ONE grouped
// `ArchiveModal` opened from the always-on rail archive button.
//
// The distinctive #473 contract, NOT pinned by the sibling specs, is what this
// spec exists to guard:
//   * Every rail button now carries a VISIBLE TEXT LABEL next to its glyph
//     (`.rail-action-label`) — the whole point of #473 (the bare emoji had to
//     be guessed / long-pressed). The siblings assert testid COUNTS
//     (issue291 mobile full-7, ux-5-bm/bt relocation); none pins the desktop
//     rail's labelled-button SET as a whole. Test (a) does.
//   * The archive button is ALWAYS shown (like settings), NOT selection-gated,
//     so the ONE archive surface is reachable from HOME — where there is no
//     network context — not just from a channel/server window. Test (b) pins
//     that from the post-login home default (the pre-#473 doors were all
//     selection- or sidebar-bound).
//   * The full PART → grouped-modal → lazy-expand → revive round trip on
//     desktop (test c) and its mobile parity via the collapsed drawer (test d).
//
// Capability gating (RailActions.tsx): home / themes / archive / settings are
// always shown; rooms needs a network context (channel/server window); denoise
// is channel-gated; admin is isAdmin()-gated. vjt is a NON-admin, so on a
// channel window it sees SIX labelled buttons and the admin button is ABSENT —
// the isAdmin() gate's negative arm. The admin-present arm (the full seven) is
// owned by issue291 / ux-6-c, which promote vjt via setAdminFlag; this spec
// stays on the plain non-admin baseline to keep the shared stack untouched.
//
// Projects (playwright.config.ts): the plain-title tests run on chromium
// (desktop 1280×720); the `@webkit` test runs on webkit-iphone-15 (393×852,
// touch, isMobile() = true). Write ≥1 desktop + ≥1 @webkit per the #473 e2e
// contract — the rail is present on both form factors but the mobile door is a
// collapsed drawer, a distinct touch path a real iOS user produces.

import { expect, test } from "../fixtures/test";
import {
  closeMembersDrawer,
  expandArchiveGroup,
  loginAs,
  openArchive,
  openMembersDrawer,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0]; // #bofh — the seeded autojoin channel

// The rail buttons a NON-admin (vjt) sees on a CHANNEL window, each paired with
// the `.rail-action-label` text #473 gave it. Admin is excluded — it is
// isAdmin()-gated and asserted ABSENT for vjt below. Order mirrors the render
// order in RailActions.tsx (home · rooms · themes · archive · settings ·
// denoise), but the assertions are per-button so order drift is not the signal.
const RAIL_BUTTONS: ReadonlyArray<{ testid: string; label: string }> = [
  { testid: "mobile-panel-home", label: "home" },
  { testid: "mobile-panel-list", label: "rooms" },
  { testid: "mobile-panel-themes", label: "themes" },
  { testid: "mobile-panel-archive", label: "archive" },
  { testid: "action-cluster-cog", label: "settings" },
  { testid: "presence-toggle", label: "denoise" },
];

test.setTimeout(60_000);

test.afterEach(async () => {
  // Tests (c) + (d) PART #bofh into the archive; restore the seed-joined state
  // so downstream specs still find the autojoin channel. Idempotent — a 404 on
  // an already-joined channel is treated as success by joinChannel's caller
  // contract (mirrors ux-1 / ux-2 / cp15-b6).
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

test.describe("#473 — RailActions drawer + grouped ArchiveModal", () => {
  test("desktop channel window — rail hosts every labelled button; admin absent for a non-admin", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    // Desktop `.shell-members` is the permanent right rail — no drawer to open.
    const rail = page.locator(".shell-members .rail-actions");
    await expect(rail).toBeVisible();

    // Each rail button renders its glyph AND its text label side by side. The
    // label text IS the #473 feature under guard — assert both the icon span is
    // present and the label carries the exact word.
    for (const { testid, label } of RAIL_BUTTONS) {
      const button = rail.locator(`[data-testid='${testid}']`);
      await expect(button).toBeVisible();
      await expect(button.locator(".rail-action-icon")).toHaveCount(1);
      await expect(button.locator(".rail-action-label")).toHaveText(label);
    }

    // admin is isAdmin()-gated: vjt is a non-admin, so the button never renders.
    await expect(rail.locator("[data-testid='mobile-panel-admin']")).toHaveCount(0);
  });

  test("desktop home — archive is always-on (no selection) and opens the grouped modal", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    // Cold-load lands on the home window (non-channel, no network context). The
    // archive button is always shown regardless — the #473 ruling that the ONE
    // archive surface must be reachable from home / mentions / admin, not just a
    // window that resolves a network. No selectChannel: the rail archive button
    // is the door.
    await loginAs(page, vjt);

    const modal = await openArchive(page);
    // The modal is a labelled dialog with the network-agnostic "Archive" title
    // (the pre-#473 per-network "Archive — <slug>" header is gone — the modal
    // groups every network now).
    await expect(modal).toHaveAttribute("role", "dialog");
    await expect(modal).toHaveAttribute("aria-labelledby", "archive-modal-title");
    await expect(modal.locator("#archive-modal-title")).toHaveText("Archive");

    // One collapsible group per network, collapsed by default (rows load
    // lazily on first expand). The seeded network's group is present + closed.
    const group = page.getByTestId(`archive-modal-group-${NETWORK_SLUG}`);
    await expect(group).toBeVisible();
    await expect(group.locator("summary.archive-modal-group-summary")).toHaveText(NETWORK_SLUG);
    expect(await group.getAttribute("open")).toBeNull();
  });

  test("desktop — PART → grouped modal lazy-loads the row → clicking it revives + closes the modal", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    // PART via REST → :parted → the channel leaves the active sidebar and moves
    // into the archive.
    await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

    // Open the ONE archive door + expand the network group — the group's
    // `<details onToggle>` lazily fires loadArchive, so the row only exists
    // after the expand (the lazy contract). The PARTed channel is listed.
    await openArchive(page);
    const group = await expandArchiveGroup(page, NETWORK_SLUG);
    const archivedRow = group.locator(".archive-modal-row", { hasText: CHANNEL });
    await expect(archivedRow).toHaveCount(1, { timeout: 5_000 });

    // Click the row's entry button → setSelectedChannel moves focus to the
    // parted channel (read-only) AND the modal closes (handleSelectEntry's
    // close()). Selection moved: the TopicBar carries the channel name.
    await archivedRow.locator(".archive-modal-entry-btn").click();
    await expect(page.locator(".archive-modal")).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator(".topic-bar")).toContainText(CHANNEL, { timeout: 5_000 });
  });

  test("@webkit mobile — drawer hosts every labelled button; PART → rail archive → grouped modal row", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    // On mobile the rail is a collapsed drawer — open it via the members
    // hamburger. The SAME `.rail-actions` component with the SAME labelled
    // buttons is mounted here.
    await openMembersDrawer(page);
    const rail = page.locator(".shell-members.open .rail-actions");
    await expect(rail).toBeVisible();
    for (const { testid, label } of RAIL_BUTTONS) {
      const button = rail.locator(`[data-testid='${testid}']`);
      await expect(button).toBeVisible();
      await expect(button.locator(".rail-action-label")).toHaveText(label);
    }
    await expect(rail.locator("[data-testid='mobile-panel-admin']")).toHaveCount(0);

    // Close the drawer before the archive flow so openArchive opens it fresh
    // (opening an already-open drawer would toggle the hamburger the wrong way).
    await closeMembersDrawer(page);

    // PART → archived. Then reach the ONE archive door via the rail (openArchive
    // is viewport-aware: on mobile it opens the drawer then taps the always-on
    // archive button). Expand the group → the lazy row load surfaces #bofh.
    await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

    await openArchive(page);
    const group = await expandArchiveGroup(page, NETWORK_SLUG);
    await expect(group.locator(".archive-modal-row", { hasText: CHANNEL })).toHaveCount(1, {
      timeout: 5_000,
    });
  });
});
