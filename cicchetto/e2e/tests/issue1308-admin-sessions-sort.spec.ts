// #1308 — the admin Sessions list had no sort at all: the order was the
// merge's assembly order (visitors, then credentials, then orphan pids)
// and the operator could not change it. vjt asked for asc/desc on last
// active / last joined / last seen, default last joined desc.
//
// jsdom already covers the comparator and the rendered row order
// (`adminSubjectRows.test.ts`, `AdminSessionsTab.test.tsx`). What only a
// real stack can show is that the two halves are wired to REAL data: the
// row set is assembled from three live endpoints, and `last joined` for a
// user row comes from a credential field that was on the wire all along
// and reached no row until this change. A comparator fed a null it should
// have been fed a timestamp still sorts — it just sorts everything to the
// bottom, and the unit tests hand it the value directly.
//
// The oracle is a DISPLACEMENT, not an absolute position: the stack is
// shared and other specs mint visitors of their own, so "my row is first"
// is a claim about their timing rather than about the sort. What cannot
// be explained away is one pair of rows swapping places when the
// direction flips, and the pair is chosen so the sort has to disagree
// with the assembly order to be right — the visitor is minted NOW, so it
// is the newest subject on the table, while the merge assembles visitors
// BEFORE users.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.

import type { Page } from "@playwright/test";
import { adminSessionRowKey, openAdminSessionsTab } from "../fixtures/cicchettoPage";
import { mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

/** The rendered row order, as the composite keys the table is keyed on. */
async function renderedRowKeys(page: Page): Promise<string[]> {
  const ids = await page
    .locator("[data-testid^='admin-session-row-']")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""));
  return ids.map((id) => id.replace("admin-session-row-", ""));
}

test("admin Sessions view: last joined desc by default, and the toggle really reorders", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const visitorNick = `sortvictim-${Date.now()}`;
  const visitor = await mintVisitor(visitorNick);

  try {
    await page.addInitScript(
      ([token, subjectJson]) => {
        localStorage.setItem("grappa-token", token);
        localStorage.setItem("grappa-subject", subjectJson);
        localStorage.setItem("cic.installChoice", "browser");
      },
      [admin.token, admin.subjectJson] as const,
    );
    await page.goto("/");
    await openAdminSessionsTab(page);

    // Both halves of the claim need both kinds on screen: `last joined`
    // existed on the visitor row before #1308 and on the user row only
    // after it, so a single-kind table would pass on the old code.
    const visitorKey = await adminSessionRowKey(page, "visitor", visitor.id);
    await expect(page.getByTestId(`admin-session-row-${visitorKey}`)).toBeVisible();
    const userRow = page.locator("[data-testid^='admin-session-row-user:']").first();
    await expect(userRow).toBeVisible({ timeout: 15_000 });
    const userKey = ((await userRow.getAttribute("data-testid")) ?? "").replace(
      "admin-session-row-",
      "",
    );

    const descending = await renderedRowKeys(page);
    expect(
      descending,
      "both rows must be on the table for the order between them to mean anything",
    ).toEqual(expect.arrayContaining([visitorKey, userKey]));

    // The default, and the part that has to disagree with the merge: the
    // visitor was created seconds ago and every seeded credential predates
    // the stack, so newest-first puts the visitor ABOVE the user — the
    // reverse of the assembly order, which lists visitors first only by
    // accident of the same direction.
    expect(
      descending.indexOf(visitorKey),
      "default is last joined DESC: the just-minted visitor outranks a seeded credential",
    ).toBeLessThan(descending.indexOf(userKey));

    // The control says which key is on and which way it points, before it
    // is used: a toggle that reorders but never marks itself leaves the
    // operator guessing what they are looking at.
    const joinedButton = page.getByTestId("admin-sessions-sort-last_joined");
    await expect(joinedButton).toHaveAttribute("aria-pressed", "true");
    await expect(joinedButton).toContainText("▼");

    await joinedButton.click();
    await expect(joinedButton).toContainText("▲");

    const ascending = await renderedRowKeys(page);
    expect(
      ascending.indexOf(visitorKey),
      "ascending must put the newest subject BELOW the oldest — the pair swaps",
    ).toBeGreaterThan(ascending.indexOf(userKey));
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});
