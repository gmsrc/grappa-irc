// #677 — channel directory: pages past page 1, and the search key no
// longer outlives its input. TWO defects, one pane, verified in a real
// browser (jsdom is blind to IntersectionObserver + scroll layout):
//
//   Defect 1 — the directory never paged past the first 100 rows. The store
//     dropped `next_cursor` and the pane had no load-more. Assert: scrolling
//     to the bottom appends a second page → >100 rows actually appear.
//   Defect 2 — the search key survived the pane unmount (it lives in the
//     identity-scoped store) while the box remounted empty, so a reopened
//     directory showed a filtered list with an empty box. Assert: reopening
//     shows an UNFILTERED list and an EMPTY box (they agree).
//
// Why stub GET /directory (page.route) instead of a real LIST: the server
// already keyset-paginates correctly (proven on origin/main); BOTH defects
// are pure client wiring, so synthetic pages exercise the exact cursor
// round-trip + append the fix adds — deterministically. A real Azzurra LIST
// has thousands of channels but a non-deterministic count; the private
// testnet only lists a handful of non-empty channels. Neither yields a
// stable "exactly 100, then >100". page.route is the established idiom here
// (21 specs); the real backend still serves login + everything else.

import type { Page } from "@playwright/test";
import { loginAs, sidebarWindow } from "../fixtures/cicchettoPage";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

// LIST_WINDOW_NAME from src/lib/windowKinds.ts, mirrored rather than imported to
// keep src VALUES out of the e2e runtime graph (fixtures/grappaApi.ts). NOT
// because the e2e tsconfig cannot resolve src/ — it can, and that fixture proves
// it (#1646). Pinned by src/__tests__/e2eConstantMirrors.test.ts.
const LIST_WINDOW_NAME = "$list";

const CAPTURED_AT = "2026-08-02T12:00:00Z";

// A full synthetic page: 100 rows named `#<prefix>-000`..`#<prefix>-099`,
// descending user_count so the "users" sort order is stable.
function fullPage(prefix: string, nextCursor: string | null, total: number) {
  const entries = Array.from({ length: 100 }, (_, i) => ({
    name: `#${prefix}-${String(i).padStart(3, "0")}`,
    topic: null,
    user_count: 1000 - i,
    featured: false,
  }));
  return {
    entries,
    next_cursor: nextCursor,
    total,
    captured_at: CAPTURED_AT,
    status: "fresh",
  };
}

// Matches GET /networks/<slug>/directory but NOT /directory/refresh (whose
// pathname ends in /refresh).
const isDirectoryGet = (url: URL) => url.pathname.endsWith("/directory");

async function openList(page: Page): Promise<void> {
  await sidebarWindow(page, NETWORK_SLUG, LIST_WINDOW_NAME).locator(".sidebar-window-btn").click();
}

test("#677 defect 1 — the directory pages past 100 rows on scroll", async ({ page }) => {
  const vjt = specUser();

  // Stub BEFORE login: page 1 has 100 rows + a next_cursor; the cursor'd
  // GET returns page 2 (100 more rows, no further cursor).
  await page.route(isDirectoryGet, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const url = new URL(route.request().url());
    const body = url.searchParams.get("cursor")
      ? fullPage("page2", null, 250)
      : fullPage("page1", "CURSOR2", 250);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await loginAs(page, vjt);
  await openList(page);

  // Page 1: exactly 100 rows; the page-2 tail row is absent.
  const rows = page.locator(".directory-row");
  await expect(rows).toHaveCount(100, { timeout: 10_000 });
  await expect(page.getByText("#page2-099")).toHaveCount(0);

  // Scroll the load-more sentinel into view → IntersectionObserver fires →
  // loadMore appends page 2. Rows accumulate to 200 (append, not replace).
  await page.locator(".directory-sentinel").scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(200, { timeout: 10_000 });
  await expect(page.getByText("#page2-099")).toBeVisible();
  // Page-1 rows are still present — the append kept them.
  await expect(page.getByText("#page1-000")).toBeVisible();
});

test("#677 defect 2 — reopening the directory is unfiltered with an empty box", async ({
  page,
}) => {
  const vjt = specUser();

  // Unfiltered GET → page 1 (no further pages, to keep the DOM small). A
  // GET carrying ?q= → a single matching row named after the query.
  await page.route(isDirectoryGet, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const url = new URL(route.request().url());
    const q = url.searchParams.get("q") ?? "";
    const body = q
      ? {
          entries: [{ name: `#match-${q}`, topic: null, user_count: 5, featured: false }],
          next_cursor: null,
          total: 1,
          captured_at: CAPTURED_AT,
          status: "fresh",
        }
      : fullPage("page1", null, 100);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await loginAs(page, vjt);
  await openList(page);

  const search = page.locator(".directory-search");
  await expect(page.getByText("#page1-000")).toBeVisible({ timeout: 10_000 });

  // Type a filter → server-side re-GET returns only the matching row.
  await search.fill("special");
  await expect(page.getByText("#match-special")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("#page1-000")).toHaveCount(0);

  // Close the directory window (✕).
  await page.locator(".directory-close").click();
  await expect(page.locator(".directory-pane")).toHaveCount(0, { timeout: 5_000 });

  // Reopen: the box is EMPTY and the list is UNFILTERED — the two agree.
  await openList(page);
  await expect(search).toHaveValue("");
  await expect(page.getByText("#page1-000")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("#match-special")).toHaveCount(0);
});
