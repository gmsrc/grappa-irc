// UX-6 bucket G (2026-05-21) — admin tables on mobile render the
// horizontal scrollbar but ignore the iOS pan-x gesture (vjt iPhone
// dogfood: "horiz content, scrollbar, but content doesn't move").
//
// Root cause: `.admin-pane` carries `touch-action: pan-y` (UX-5 BO
// defensive carve-out against the `.shell-mobile { touch-action: none }`
// blanket). Browser `touch-action` is the INTERSECTION across the
// ancestor chain — even when `.admin-tab-panel` declares `pan-x pan-y`,
// the parent's `pan-y` clamps back to `pan-y` only. Result: the
// table renders an overflow-x scrollbar (visual cue) but iOS rejects
// the horizontal pan, so the operator cannot read columns past the
// viewport.
//
// Fix (CSS-only, two declarations):
//   1. `.admin-pane { touch-action: pan-x pan-y }` — relaxes the
//      ancestor INTERSECTION ceiling so child pan-x can take effect.
//   2. `.admin-tab-panel { overflow-x: auto; touch-action: pan-x pan-y }`
//      — table scrolls inside the panel (not the page); the panel
//      itself owns the gesture authority for pan-x.
//
// #1074 INVERTED the other half of this contract. The gesture
// PERMISSION survives verbatim and is still asserted below: a table
// that fits must not trap a horizontal swipe, and a future hand
// re-tightening either declaration back to `pan-y` would silently
// re-break the pane. What flipped is the positive-width twin. This
// spec used to name Networks as `DETERMINISTIC_WIDE_TAB` and assert it
// was WIDER than its panel, to prove the permission wasn't trivially
// passing on an empty tab. Networks now drops its secondary columns
// into the row's detail like every other tab, so the claim is the
// opposite one: on a phone, NO admin tab is wider than its panel.
//
// The row-detail case at the bottom is the other half of the same
// knot. The detail panel sat OUTSIDE the table, rendered before it,
// precisely because the table was wider than a phone; opening a row
// therefore pushed the list down and sent the viewport to the top
// ("l'expansion delle righe non deve portare top"). It is an expand
// row now, and the oracle is that the row it belongs to does not move
// when it opens.
//
// Per `feedback_e2e_user_class_parity_matrix`: AdminPane is admin-
// gated (EXEMPT). This spec runs the admin arm only; non-admin
// can't reach the surface at all.
//
// Seed shape: same as UX-6-C — PATCH the seeded `vjt` user to admin
// via admin-vjt bearer at test start, revert in afterEach. admin-vjt
// has no IRC bind (m9b session-count == 2 hardcode); vjt has the bind
// + autojoined #bofh so it can reach the mobile launcher footer.

import type { Page } from "@playwright/test";
import { loginAs, openRailMenu, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededAdmin, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const GRAPPA_BASE_URL = "http://grappa-test:4000";

// The tabs the pre-#1074 contract named as candidates for pan-x.
// Networks is still the only one with rows in the baseline seed, so it
// is still the only one whose width assertion carries information —
// hence `DETERMINISTIC_POPULATED_TAB` below. Visitors / Sessions are
// empty here and would pass the fits-the-panel check trivially; they
// stay in the loop for the touch-action half, which does not depend on
// content.
const ADMIN_TABLE_TABS = ["visitors", "sessions", "networks"] as const;
const DETERMINISTIC_POPULATED_TAB = "networks" as const;

test.setTimeout(90_000);

async function findVjtUserId(adminToken: string): Promise<string> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/users`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) {
    throw new Error(`GET /admin/users → ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { users: { id: string; name: string }[] };
  const vjt = body.users.find((u) => u.name === specUser().name);
  if (!vjt) {
    throw new Error(`vjt user not found in admin users list: ${JSON.stringify(body)}`);
  }
  return vjt.id;
}

async function setAdminFlag(adminToken: string, userId: string, isAdmin: boolean): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ is_admin: isAdmin }),
  });
  if (!res.ok) {
    throw new Error(
      `PATCH /admin/users/${userId} is_admin=${isAdmin} → ${res.status} ${await res.text()}`,
    );
  }
}

test.describe("UX-6-G — admin pane horizontal scroll on mobile", () => {
  let vjtUserId: string;

  // beforeEACH, not beforeAll: the subject is per-test (#1078), so its
  // user id has to be resolved per test — a once-per-file lookup would
  // hold the id of a user that no longer exists.
  test.beforeEach(async () => {
    const admin = getSeededAdmin();
    vjtUserId = await findVjtUserId(admin.token);
  });

  test.afterEach(async () => {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, false);
  });

  async function openAdminPane(page: Page): Promise<void> {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, true);

    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    await page.getByLabel(/open members sidebar/i).tap();
    // #500 — the admin button lives behind the rail launcher menu now.
    await openRailMenu(page);
    await page.locator(".rail-actions-menu [data-testid='mobile-panel-admin']").tap();
    await expect(page.getByTestId("admin-pane")).toBeVisible({ timeout: 5_000 });
  }

  test("@webkit admin on mobile — admin tables permit pan-x and need none of it", async ({
    page,
  }) => {
    await openAdminPane(page);

    const pane = page.getByTestId("admin-pane");

    // Pre-fix: `.admin-pane` declared `touch-action: pan-y` and the
    // CSS-spec INTERSECTION rule meant any descendant declaring
    // `pan-x pan-y` got clamped back to `pan-y` only. iOS rejected
    // the horizontal pan, the scrollbar appeared but the table did
    // not move. The permission stays asserted even though nothing
    // needs to pan any more: a tab whose content grows past the
    // viewport again (a long vhost address, a wide error) must still
    // be readable, and a swipe that does nothing is the bug this
    // bucket was opened for.
    const paneTouch = await pane.evaluate((el) => window.getComputedStyle(el).touchAction);
    expect(paneTouch, "admin-pane touch-action must allow pan-x").toMatch(/pan-x/);

    for (const tab of ADMIN_TABLE_TABS) {
      await page.getByTestId(`admin-tab-${tab}`).tap();
      const panel = page.locator(`#admin-tab-${tab}`);
      await expect(panel).toBeVisible({ timeout: 5_000 });
      const panelStyle = await panel.evaluate((el) => {
        const cs = window.getComputedStyle(el);
        return {
          touchAction: cs.touchAction,
          overflowX: cs.overflowX,
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
        };
      });
      expect(
        panelStyle.touchAction,
        `admin-tab-panel(${tab}) touch-action must allow pan-x`,
      ).toMatch(/pan-x/);
      expect(
        panelStyle.overflowX,
        `admin-tab-panel(${tab}) overflow-x must be auto/scroll so overflow scrolls the panel, not the page`,
      ).toMatch(/auto|scroll/);
      // #1074 — the inverted twin. Networks is the tab with rows in the
      // baseline seed, so it is the one where "nothing is wider than
      // the panel" is a claim about real content rather than about an
      // empty tab.
      if (tab === DETERMINISTIC_POPULATED_TAB) {
        expect(
          panelStyle.scrollW,
          `admin-tab-panel(${tab}) must not be wider than its panel on a phone`,
        ).toBeLessThanOrEqual(panelStyle.clientW);
      }
    }
  });

  test("@webkit admin on mobile — the populated tab has nothing to pan to", async ({ page }) => {
    await openAdminPane(page);

    await page.getByTestId(`admin-tab-${DETERMINISTIC_POPULATED_TAB}`).tap();
    const panel = page.locator(`#admin-tab-${DETERMINISTIC_POPULATED_TAB}`);
    await expect(panel).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("admin-networks-table")).toBeVisible({ timeout: 10_000 });

    // The behavioural twin of the width assertion above, driven through
    // the same `el.scrollLeft` channel WebKit's pan handler mutates.
    // Pre-#1074 this asked for scrollLeft=100 and demanded it stick;
    // now the demand is that the browser CLAMP it back to 0, because
    // there is no overflow to travel into. A tab that quietly grows
    // wide again fails here, not only in the computed-width check.
    const before = await panel.evaluate((el) => el.scrollLeft);
    expect(before, "panel starts at scrollLeft=0").toBe(0);
    const after = await panel.evaluate((el) => {
      el.scrollLeft = 100;
      return el.scrollLeft;
    });
    expect(after, "no admin tab may have horizontal content to scroll into").toBe(0);
  });

  test("@webkit admin on mobile — opening a row's detail does not move the row", async ({
    page,
  }) => {
    await openAdminPane(page);

    await page.getByTestId(`admin-tab-${DETERMINISTIC_POPULATED_TAB}`).tap();
    await expect(page.getByTestId("admin-networks-table")).toBeVisible({ timeout: 10_000 });

    const expander = page.locator("[data-testid^='admin-network-expand-']").first();
    await expect(expander).toBeVisible({ timeout: 5_000 });
    const before = await expander.boundingBox();
    expect(before, "expander must have a box before the tap").not.toBeNull();

    await expander.tap();
    await expect(expander).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });
    await expect(page.locator(".adm-detail").first()).toBeVisible({ timeout: 5_000 });

    // The whole complaint, as one number. When the panel rendered
    // before the table, opening it inserted a card ABOVE this row and
    // pushed it down the page — and `scrollIntoView` then dragged the
    // viewport up to the card, leaving the operator somewhere they had
    // not asked to be. In the row's own position the row stays put.
    const after = await expander.boundingBox();
    expect(after, "expander must still have a box after the tap").not.toBeNull();
    expect(
      Math.abs((after?.y ?? 0) - (before?.y ?? 0)),
      "the row an operator tapped must not move when its detail opens",
    ).toBeLessThanOrEqual(1);
  });

  test("@webkit admin on mobile — vertical scroll inside the pane still works", async ({
    page,
  }) => {
    await openAdminPane(page);

    // Negative twin: relaxing `.admin-pane` from `pan-y` to `pan-x pan-y`
    // must keep pan-y intact (a careless rewrite to `pan-x` alone would
    // silently drop vertical scroll while passing the pan-x asserts
    // above). Both axes must remain in the touch-action declaration.
    const paneTouch = await page
      .getByTestId("admin-pane")
      .evaluate((el) => window.getComputedStyle(el).touchAction);
    expect(paneTouch, "admin-pane touch-action must STILL allow pan-y").toMatch(/pan-y/);
    expect(paneTouch, "admin-pane touch-action must allow pan-x").toMatch(/pan-x/);
  });
});
