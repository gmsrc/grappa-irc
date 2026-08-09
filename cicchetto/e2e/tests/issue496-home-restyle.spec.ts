// #496 — home-pane rework: friendlier always-on copy, HONEST per-subject
// session-lifetime text, and a network row that hides the (broken-/links)
// Map button. ONE parameterised spec across the three subject kinds
// (feedback_e2e_user_class_parity_matrix) asserting the RENDERED copy +
// the ABSENCE of the Map button — the visible outcomes jsdom can't prove.
//
//   * registered user      — ∞ IRC connection + a 7-day DEVICE auth idle
//     (Grappa.Accounts @idle_timeout_seconds). A flat "never expires" is
//     false; the 7-day fact must render.
//   * unregistered visitor — 48h sliding TTL (Grappa.Visitors).
//   * registered visitor   — ∞ (visitor_registered?/1 short-circuits touch/1).
//
// The exact strings + the ∞/48h/7-day facts are pinned in the pure-fn unit
// test (src/lib/homeSessionCopy.test.ts); this spec proves cic RENDERS the
// right branch per real subject and hides the Map control.
//
// Desktop chromium (untagged): the copy is layout-agnostic, and the home
// landing is reached via the desktop `.sidebar-home-btn` (mirrors the #392
// home-restyle-share precedent). The registered-visitor branch flips the
// server-derived identity-wide `registered` boolean via a /me route overlay
// — everything else (token, home_data.networks, render) is real; that the
// server DERIVES `registered` from the credentials is covered server-side
// (Grappa.Networks.Credentials.visitor_registered?/1 tests).

import type { Page } from "@playwright/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { type MintedVisitor, mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

// Seed a visitor bearer + subject into localStorage before the SPA boots
// (mirror of the #392 helper).
async function seedVisitor(page: Page, visitor: MintedVisitor): Promise<void> {
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [visitor.token, JSON.stringify(visitor.subject)] as const,
  );
}

// Overlay `registered: true` onto the real GET /me body so the registered-
// visitor copy branch renders. Real token + real home_data ride through; only
// the one server-derived boolean is flipped (see file header).
async function forceRegisteredMe(page: Page): Promise<void> {
  await page.route(/\/me(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const resp = await route.fetch();
    const body = (await resp.json()) as Record<string, unknown>;
    body.registered = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

async function gotoHome(page: Page): Promise<void> {
  await page.locator(".sidebar-home-btn").first().click();
  await expect(page.locator(".home-pane-registered").first()).toBeVisible({ timeout: 10_000 });
}

type SubjectCase = {
  label: string;
  sessionTestid: string;
  // A fact that MUST appear in the rendered session copy for this subject.
  factRe: RegExp;
  // Land on the home pane as this subject; returns a teardown thunk.
  arrive: (page: Page) => Promise<() => Promise<void>>;
};

const SUBJECTS: SubjectCase[] = [
  {
    label: "registered user",
    sessionTestid: "home-session-user",
    factRe: /7 days/i,
    async arrive(page) {
      await loginAs(page, specUser());
      await gotoHome(page);
      return async () => {};
    },
  },
  {
    label: "unregistered visitor",
    sessionTestid: "home-session-visitor-guest",
    factRe: /48 hours/i,
    async arrive(page) {
      const admin = getSeededAdmin();
      const visitor = await mintVisitor(`i496g-${Date.now()}`);
      await seedVisitor(page, visitor);
      await page.goto("/");
      await gotoHome(page);
      return async () => {
        await reapVisitors(admin.token, visitor.id);
      };
    },
  },
  {
    label: "registered visitor",
    sessionTestid: "home-session-visitor-registered",
    // Honest both-truths copy: identity/history kept for good, but the DEVICE
    // login still slides 7 days (Accounts.check_idle is subject-blind).
    factRe: /kept for good/i,
    async arrive(page) {
      const admin = getSeededAdmin();
      const visitor = await mintVisitor(`i496r-${Date.now()}`);
      await seedVisitor(page, visitor);
      await forceRegisteredMe(page);
      await page.goto("/");
      await gotoHome(page);
      return async () => {
        await reapVisitors(admin.token, visitor.id);
      };
    },
  },
];

test.describe("#496 — home restyle: per-subject session copy + no Map button", () => {
  for (const subject of SUBJECTS) {
    test(`${subject.label}: session copy renders and the Map button is hidden`, async ({
      page,
    }) => {
      const teardown = await subject.arrive(page);
      try {
        // (1) The per-subject session-lifetime copy renders with its fact.
        const session = page.getByTestId(subject.sessionTestid);
        await expect(session).toBeVisible({ timeout: 10_000 });
        await expect(session).toHaveText(subject.factRe);

        // (2) The always-on value prop (req #1) — plain-language, shown to all.
        await expect(page.getByText(/no reconnecting, nothing lost/i)).toBeVisible();

        // (3) The networks intro line (req #3) precedes the list.
        await expect(page.getByText(/networks you can chat on/i)).toBeVisible();

        // (4) The Map button (req #3) is hidden behind the /links flag — no
        // per-network topology control anywhere on the pane.
        await expect(page.locator(".home-pane-network-topology")).toHaveCount(0);
        await expect(page.getByRole("button", { name: /network map/i })).toHaveCount(0);

        // (5) Curated-channels intro (req #5): present iff a featured list is —
        // absent list, absent text. Robust to testnet featured config.
        const featured = page.locator('[data-testid^="home-featured-"]').first();
        if (await featured.count()) {
          await expect(page.getByText(/worth a look on/i).first()).toBeVisible();
        }
      } finally {
        await teardown();
      }
    });
  }
});
