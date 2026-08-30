// UX-5 bucket BT — narrow-mode chrome+topic compression + sidebar
// network-name nit (left-align + bold).
//
// Pre-bucket symptoms (vjt 2026-05-19 dogfood):
//   * Narrow viewport (iPhone, ≤768px): TWO rows above the scrollback
//     area — `.shell-chrome` (archive/cog) THEN `.topic-bar`
//     (channel/topic/modes/count/hamburger). Each ~32px tall, together
//     eating ~25% of the visible scrollback on a 393×852 iPhone shape.
//   * Desktop sidebar: the network-header row (UX-4 bucket C) renders
//     the slug `<span class="sidebar-channel-name">` with regular
//     weight and the default `.sidebar-window-btn`
//     `justify-content: space-between` floats it toward the middle of
//     the row instead of left-anchored against the ⚙️ emoji.
//
// Post-bucket end state:
//   * Mobile + channel: `.shell-chrome` row is NOT mounted; the archive
//     + cog buttons live INSIDE `.topic-bar` (one row total above the
//     scrollback area, reclaiming ~32px).
//   * Mobile + home / mentions / admin / server: `.shell-chrome` row
//     STAYS (no TopicBar to absorb the buttons). Cog reachable.
//   * Desktop (any window): unchanged. Two rows on channel windows
//     (chrome + topic-bar separately stacked).
//   * Desktop sidebar: network-header `.sidebar-channel-name` is
//     `font-weight: bold` + the header `.sidebar-window-btn` uses
//     `justify-content: flex-start` so the slug is left-anchored.
//
// UX-5 bucket BM (2026-05-20) → #473 — three buttons on the narrow row
// was still crowded (vjt 2026-05-19 dogfood, follow-up). BM moved archive
// + cog OUT of the topic-bar inline slot into a launcher footer inside the
// mobile members drawer; #473 retired that footer for `.rail-actions`, the
// ONE labelled action drawer at the bottom of `.shell-members` (present on
// both form factors, every window kind). The mobile arm below pins the
// post-state: cog + archive NOT inline in the topic-bar anymore; only the
// hamburger survives on its right edge, and the cog + archive live in the
// rail drawer. The "no standalone .shell-chrome row on mobile-channel"
// contract from BT still holds — that part is BT's reclamation; the buttons
// just moved into the rail without bringing the chrome row back.
//
// jsdom doesn't compute layout / cascade `@media` — per
// `feedback_cicchetto_browser_smoke` this CSS-driven layout fix MUST
// ship a Playwright e2e. Mobile arm pins the inline-vs-standalone
// chrome contract; desktop arm pins the negative-twin (desktop
// unchanged) PLUS the sidebar nit (getComputedStyle on the header
// span + button).
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: UI shape
// contract, subject-shape-agnostic. Registered seed suffices.

import {
  closeMembersDrawer,
  loginAs,
  openRailMenu,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(60_000);

test("ux-5-bt desktop — #71 INC-2: NO chrome row; topic-bar + rail cog; sidebar network-name bold + left-aligned", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Cold-load lands on home. #71 INC-2 removed the desktop .shell-chrome row
  // (cog moved to the permanent right rail); #500 folded the cog behind the rail
  // launcher menu, so open it (desktop: taps the launcher) then assert the cog.
  await openRailMenu(page);
  await expect(page.locator(".rail-actions-menu [data-testid='action-cluster-cog']")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator(".shell-chrome")).toHaveCount(0);
  // #1040 — on home the rail IS the expanded menu, so there is nothing here to
  // close and the old `Escape` + count-0 pair asserted the collapsed contract.
  // Two things it claimed are both false now, and neither was ever the point:
  // the "full-viewport backdrop" it named does not exist (RailActions dismisses
  // on an outside pointerdown, with no covering scrim — so nothing has been
  // intercepting the click below for some time), and Escape is deliberately
  // INERT on home (a permanent column the operator could close with a keypress
  // is one they could not bring back). Assert the #1040 contract instead —
  // Escape does NOT take the column away — which is strictly more than the old
  // line said, and let the `selectChannel` below keep being the real proof that
  // nothing intercepts the sidebar click.
  await page.keyboard.press("Escape");
  await expect(page.locator(".rail-actions.expanded .rail-actions-menu")).toHaveCount(1, {
    timeout: 5_000,
  });

  // Switch to a joined channel — topic-bar mounts (no chrome row above it on
  // desktop anymore; the freed top is the topic's per INC-2).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();
  await expect(page.locator(".shell-chrome")).toHaveCount(0);
  await expect(page.locator(".topic-bar")).toHaveCount(1);
  // Cog must NOT be inside .topic-bar on desktop — it lives in the rail. Assert
  // the LIVE `action-cluster-cog` testid is absent from the topic-bar (the
  // retired `shell-chrome-cog` is gone from the DOM, so it would be vacuous).
  await expect(page.locator(".topic-bar [data-testid='action-cluster-cog']")).toHaveCount(0);
  // #500 — re-open the launcher menu on the channel window; the cog is reachable
  // in the rail (not the topic-bar).
  await openRailMenu(page);
  await expect(page.locator(".rail-actions-menu [data-testid='action-cluster-cog']")).toBeVisible();

  // Sidebar network-name nit: header span computed weight is bold +
  // header button uses flex-start justification. getComputedStyle
  // returns "700" for bold (browser-normalized; "bold" keyword also
  // accepted defensively).
  const headerName = page.locator(
    "li.sidebar-network-header .sidebar-window-btn .sidebar-channel-name",
  );
  await expect(headerName).toBeVisible();
  const headerNameWeight = await headerName.evaluate((el) => getComputedStyle(el).fontWeight);
  expect(["700", "bold"]).toContain(headerNameWeight);

  const headerBtn = page.locator("li.sidebar-network-header .sidebar-window-btn");
  const headerBtnJustify = await headerBtn.evaluate((el) => getComputedStyle(el).justifyContent);
  expect(headerBtnJustify).toBe("flex-start");
});

test("@webkit @touch ux-5-bt mobile — channel: NO standalone .shell-chrome row (#473 moved chrome buttons into the RailActions drawer)", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Cold-load lands on home — TopicBar absent. The chrome element STAYS on
  // mobile-home (no TopicBar to host the ☰), which is what this test is about:
  // mounted here, absent on a channel. #985 took away its BAND, not its
  // existence — `height: 0` with the ☰ floated over the pane's corner — so the
  // host reads as hidden to Playwright while `toHaveCount(1)` on the next line
  // still says exactly what this precondition meant. The door is witnessed
  // directly instead.
  await expect(page.locator(".shell-chrome")).toHaveCount(1);
  await expect(page.getByTestId("shell-chrome-rail-opener")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".topic-bar")).toHaveCount(0);

  // Switch to channel via BottomBar (mobile selectChannel handles the
  // tap path internally).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // BT compression contract: .shell-chrome row NOT mounted in the
  // mobile-channel branch; .topic-bar IS mounted.
  await expect(page.locator(".topic-bar")).toHaveCount(1);
  await expect(page.locator(".shell-chrome")).toHaveCount(0);
  // #473 contract: cog + archive NO LONGER inline in .topic-bar — they live in
  // the `.rail-actions` drawer now. Assert their LIVE testids (`action-cluster-cog`
  // / `mobile-panel-archive`) are absent from the topic-bar (the retired
  // `shell-chrome-cog` / `shell-chrome-archive` are gone from the DOM, so
  // pointing at them would be vacuous).
  await expect(page.locator(".topic-bar [data-testid='action-cluster-cog']")).toHaveCount(0);
  await expect(page.locator(".topic-bar [data-testid='mobile-panel-archive']")).toHaveCount(0);
  // The affordances live inside the members drawer's `.rail-actions` launcher
  // menu (see ux-5-bm spec for the full mutex contract). Verified here as a
  // sanity link between the BT reclamation and the #473/#500 relocation: the cog
  // + archive rows are present in the rail launcher menu. openRailMenu opens the
  // members drawer then the launcher (mobile), revealing the buttons.
  await openRailMenu(page);
  await expect(page.locator(".rail-actions-menu [data-testid='action-cluster-cog']")).toHaveCount(
    1,
  );
  await expect(page.locator(".rail-actions-menu [data-testid='mobile-panel-archive']")).toHaveCount(
    1,
  );
  // #500 — opening the launcher opened the members drawer + menu; close both so
  // the hamburger tap-target checks + the re-open below run against the clean
  // topic-bar state (the open drawer/backdrop would otherwise occlude the tap).
  await page.keyboard.press("Escape");
  await expect(page.locator(".rail-actions-menu")).toHaveCount(0, { timeout: 5_000 });
  await closeMembersDrawer(page);

  // #305 — the mobile members hamburger ADOPTS `.shell-chrome-btn` and so
  // sizes from the shared tokens: the tap target meets the 48px HIG floor
  // (--chrome-tap-min, up from the old bespoke 44px box) and the ☰ glyph is
  // enlarged (--chrome-icon-size: 1.4rem, up from the base 14px — defect 1).
  // Round for webkit sub-pixel; parse the computed glyph size.
  const hamburger = page.locator(".topic-bar-hamburger");
  await expect(hamburger).toBeVisible({ timeout: 5_000 });
  const hamBox = await hamburger.boundingBox();
  if (hamBox === null) throw new Error("hamburger has no bounding box");
  expect(
    Math.round(hamBox.height),
    `#305 — hamburger tap target ${hamBox.height}px must meet the 48px HIG floor`,
  ).toBeGreaterThanOrEqual(48);
  // #1766 moved this oracle from `font-size` to the PAINTED ink, and the move
  // is a strengthening, not an accommodation. `font-size` measured the em box;
  // #305's complaint was that U+2630 is three thin strokes centred in a box
  // that is not narrow, i.e. precisely that the box overstates the glyph. The
  // ☰ is now DRAWN (three rules on `::before` + two box-shadow copies), so the
  // character is suppressed and the old proxy reads 0.
  //
  // Measured on this project (root 14px → --chrome-icon-size 19.59px), ink
  // extents, canvas actualBoundingBox for the character:
  //
  //     U+2630 as text        19.59 W × 17.00 H   ← never met this floor
  //     bars, first cut (/3)  19.59 W × 15.06 H   ← the regression #1766 shipped
  //     bars, shipped         19.59 W × 19.59 H
  //
  // ⚠️ #1801 correction, first row only: that 19.59 W is the ADVANCE, not ink.
  // Re-measured against a pixel scan of the same glyph in the same engine at
  // the same size, webkit reports `actualBoundingBoxLeft + Right` as the
  // advance (painted: 17.67 W × 16.00 H) while chromium reports true ink;
  // heights are sound in both. Nothing here moves — the bars' width is
  // CSS-computed and the row that decided #1766 was the HEIGHT — but the
  // column is a box measurement in a table written to say boxes overstate
  // glyphs, so: an ink oracle is per-engine until painted pixels say
  // otherwise. #1801's own guard scans pixels for exactly that reason.
  //
  // So the threshold is unchanged at 18 and is met in BOTH axes for the first
  // time. Read off the computed shadow rather than recomputing the CSS
  // formula, so the test measures what is painted instead of restating it.
  const ink = await hamburger.evaluate((el) => {
    const before = getComputedStyle(el, "::before");
    const barH = Number.parseFloat(before.height);
    const offsets = [
      0,
      ...Array.from(before.boxShadow.matchAll(/(-?[\d.]+)px\s+(-?[\d.]+)px/g), (m) =>
        Number.parseFloat(m[2] ?? "0"),
      ),
    ];
    return {
      w: Number.parseFloat(before.width),
      h: Math.max(...offsets) + barH - Math.min(...offsets),
    };
  });
  expect(
    Math.round(ink.w),
    `#305 — drawn ☰ is ${ink.w}px wide; the glyph must clear the 18px floor`,
  ).toBeGreaterThanOrEqual(18);
  expect(
    Math.round(ink.h),
    `#305 — drawn ☰ is ${ink.h}px tall; the glyph must clear the 18px floor`,
  ).toBeGreaterThanOrEqual(18);

  // Per `feedback_e2e_visitor_members_list` — UI-shape spec is
  // registered-class today; satisfy the rule by asserting the members
  // drawer populates after a tap on the TopicBar hamburger.
  await page.getByLabel(/open members sidebar/i).tap();
  const drawer = page.locator(".shell-members.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  const memberNames = drawer.locator(".members-pane .member-name");
  await expect.poll(async () => await memberNames.count()).toBeGreaterThan(0);
  await expect(drawer).toContainText(specNick());
});
