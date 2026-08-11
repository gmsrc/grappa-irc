// UX-6 bucket G (2026-05-21) — admin tables on mobile render the
// horizontal scrollbar but ignore the iOS pan-x gesture (vjt iPhone
// dogfood: "horiz content, scrollbar, but content doesn't move").
//
// Root cause was `.admin-pane`'s `touch-action: pan-y` (a UX-5 BO carve-out
// against the `.shell-mobile { touch-action: none }` blanket) clamping the
// ancestor INTERSECTION so a child's `pan-x` could never take effect. The
// gesture PERMISSION half of that fix is still asserted below, verbatim.
//
// #1157 REPLACED the other half, and the spec has to be read as a whole to
// see why. The 2026-05 fix, and #1074 after it, both took for granted that a
// phone SHOULD pan a wide admin table, and argued only about which element
// owns the scroll. vjt reversed the premise after dogfooding 0.15.0: the pan
// is what goes. Rows become cards below 900px, and there is nothing wide
// left to travel across.
//
// That reversal forced a new oracle, because the old one had stopped
// watching. It looped `["visitors", "sessions", "networks"]` but gated the
// width assertion on `DETERMINISTIC_POPULATED_TAB = "networks"`, with a
// comment conceding that Visitors and Sessions were empty in the baseline
// seed and "would pass the fits-the-panel check trivially". So it measured
// ONE tab, the only one vjt did not ask to change — and `"visitors"` does
// not exist any more.
//
// The replacement is a claim no relocation of the scroller can satisfy: at
// 393px, on EVERY tab, no scroll container inside the admin pane may have
// `scrollWidth > clientWidth`. Moving `overflow-x` one level in or out —
// the exact trap the deleted CSS comment documented, and the thing #1074
// did — fails it, because the offender is reported wherever it lands.
//
// Restricted to containers whose computed `overflow-x` is `auto` or
// `scroll`, which is precisely the set that CAN pan. Not every overflowing
// box: an inline element reports `clientWidth: 0` and would false-positive
// on any text at all, and `overflow: hidden` is a deliberate idiom here
// (`.adm-table-truncate` clips to an ellipsis with the full value on a
// `title`), so flagging it would fail on a feature.
//
// Seeded rather than trusted: an empty tab cannot overflow, which is how
// the old spec came to be green while watching nothing. The arrange block
// mints a visitor (a Sessions row on top of the four seeded credentials)
// and creates a vhost (a Vhosts row, the tab vjt called "un puttanaio"),
// and both are torn down in `finally`.
//
// Per `feedback_e2e_user_class_parity_matrix`: AdminPane is admin-gated
// (EXEMPT). This spec runs the admin arm only; non-admin can't reach the
// surface at all.
//
// Seed shape: same as UX-6-C — PATCH the seeded `vjt` user to admin
// via admin-vjt bearer at test start, revert in afterEach. admin-vjt
// has no IRC bind (m9b session-count == 2 hardcode); vjt has the bind
// + autojoined #bofh so it can reach the mobile launcher footer.

import type { Page } from "@playwright/test";
import { loginAs, openRailMenu, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededAdmin, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const GRAPPA_BASE_URL = "http://grappa-test:4000";

// Every tab AdminPane mounts (`TABS` in AdminPane.tsx). The pan is a
// property of the pane, not of the three tabs that happened to have tables
// when this spec was written, so the oracle visits all of them.
const ADMIN_TABS = [
  "sessions",
  "events",
  "session_log",
  "networks",
  "vhosts",
  // #1158 — no `credentials` entry: the Credentials tab is gone as an
  // operator surface, its job moved onto the per-user page behind Users.
  // The claim below is "no admin tab pans sideways", so this list has to be
  // the tabs that EXIST — a stale name here reads as a 3-minute tap timeout,
  // not as a missing tab.
  "users",
  "settings",
  "debug",
] as const;

test.setTimeout(180_000);

type Offender = {
  tab: string;
  tag: string;
  testId: string | null;
  cls: string;
  scrollW: number;
  clientW: number;
};

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

// A Vhosts row to measure. Mirrors issue252's candidate rule: the address
// must be one with no vhost row yet, or the create 409s.
async function createSeedVhost(adminToken: string): Promise<number | null> {
  const idx = await fetch(`${GRAPPA_BASE_URL}/admin/vhosts`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!idx.ok) throw new Error(`GET /admin/vhosts → ${idx.status}`);
  const body = (await idx.json()) as {
    host_candidates: string[];
    vhosts: { address: string }[];
  };
  const configured = new Set(body.vhosts.map((v) => v.address));
  const address = body.host_candidates.find((a) => !configured.has(a));
  // Already-configured is fine: the tab has a row either way, which is all
  // this spec needs. Only a total absence of candidates is worth a null.
  if (address === undefined) return null;
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/vhosts`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ address, generally_available: true }),
  });
  if (!res.ok) throw new Error(`POST /admin/vhosts ${address} → ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: number }).id;
}

async function deleteSeedVhost(adminToken: string, id: number | null): Promise<void> {
  if (id === null) return;
  await fetch(`${GRAPPA_BASE_URL}/admin/vhosts/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  }).catch(() => undefined);
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

  test("@webkit admin on mobile — no tab can be panned sideways", async ({ page }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`ux6g-${Date.now()}`);
    let vhostId: number | null = null;

    try {
      vhostId = await createSeedVhost(admin.token);
      await openAdminPane(page);

      const offenders: Offender[] = [];

      for (const tab of ADMIN_TABS) {
        await page.getByTestId(`admin-tab-${tab}`).tap();
        const panel = page.locator(`#admin-tab-${tab}`);
        await expect(panel).toBeVisible({ timeout: 10_000 });

        // The pane, not just the panel: the pre-#1157 arrangement made the
        // PANEL the scroller, and a future one could push it further out.
        const found = await page.getByTestId("admin-pane").evaluate((root) => {
          const out: Omit<Offender, "tab">[] = [];
          const consider = (el: Element): void => {
            // NAMED EXEMPTION, not a filter that makes the red go away.
            // `.adm-nav` is the tab strip: nine chips, `overflow-x: auto`
            // by design (default.css), 717px in a 365px pane. It is a
            // navigation affordance an operator swipes to CHOOSE a tab,
            // which is the same gesture every phone tab bar uses — not a
            // record whose columns you must pan to READ, which is the
            // defect vjt reported and this bucket exists for. Stacking it
            // would cost most of the screen before the first row. If it is
            // ever meant to be in scope, that is a separate product call.
            if (el.classList.contains("adm-nav")) return;
            const overflowX = window.getComputedStyle(el).overflowX;
            if (overflowX !== "auto" && overflowX !== "scroll") return;
            if (el.scrollWidth <= el.clientWidth + 1) return;
            out.push({
              tag: el.tagName.toLowerCase(),
              testId: el.getAttribute("data-testid"),
              cls: String((el as HTMLElement).className ?? "").slice(0, 90),
              scrollW: el.scrollWidth,
              clientW: el.clientWidth,
            });
          };
          consider(root);
          for (const el of root.querySelectorAll("*")) consider(el);
          return out;
        });

        offenders.push(...found.map((o) => ({ ...o, tab })));
      }

      expect(
        offenders,
        `nothing in the admin pane may be pannable at 393px, on any tab — ` +
          `offenders: ${JSON.stringify(offenders, null, 2)}`,
      ).toEqual([]);
    } finally {
      await deleteSeedVhost(admin.token, vhostId);
      await reapVisitors(admin.token, visitor.id);
    }
  });

  test("@webkit admin on mobile — the pane still permits pan-x", async ({ page }) => {
    await openAdminPane(page);

    // Kept from the original fix and deliberately NOT deleted along with
    // the overflow it was paired to. Nothing needs to pan any more, but a
    // pane that REFUSES a horizontal gesture is the bug this bucket was
    // opened for, and a future hand re-tightening either declaration back
    // to `pan-y` would silently restore it. Cheap to keep, and it fails on
    // a cause the width oracle above cannot see.
    const paneTouch = await page
      .getByTestId("admin-pane")
      .evaluate((el) => window.getComputedStyle(el).touchAction);
    expect(paneTouch, "admin-pane touch-action must allow pan-x").toMatch(/pan-x/);

    for (const tab of ADMIN_TABS) {
      await page.getByTestId(`admin-tab-${tab}`).tap();
      const panel = page.locator(`#admin-tab-${tab}`);
      await expect(panel).toBeVisible({ timeout: 10_000 });
      const panelTouch = await panel.evaluate((el) => window.getComputedStyle(el).touchAction);
      expect(panelTouch, `admin-tab-panel(${tab}) touch-action must allow pan-x`).toMatch(/pan-x/);
    }
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

  test("@webkit admin on mobile — opening a row's detail does not move the row", async ({
    page,
  }) => {
    await openAdminPane(page);

    await page.getByTestId("admin-tab-networks").tap();
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
});
