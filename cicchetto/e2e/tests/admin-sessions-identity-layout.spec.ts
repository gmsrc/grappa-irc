// #1157 — browser-truth layout lock for the unified Sessions view's identity
// column. jsdom is blind to CSS (`feedback_cicchetto_browser_smoke`), so
// everything asserted here can ONLY be pinned in a real browser.
//
// This spec replaces `admin-visitors-layout.spec.ts`, which locked the same
// CLASS of defect on the tab #1157 deleted. That defect (2026-07-12, from
// priv/admin-fuckup.png) was a per-network cell rendering as one glued run —
// `pelucheazzurraconnected` — because the `<ul class="admin-visitor-networks">`
// shipped WITHOUT CSS after the #211-phase-7 cutover, so the browser fell back
// to its defaults. The tab is gone; the trap is not. The unified view's
// identity cell is the next cutover to ship markup whose layout exists only in
// CSS, so the lock moves onto it rather than being deleted with its subject.
//
// What is asserted is vjt's dictation for column 1 (2026-08-09), which is
// four separate CSS facts and therefore four separate assertions — each one
// killed by a different missing rule:
//
//   1. the `visitor` and `user` badges are the SAME WIDTH — the words are
//      different lengths, and an unpadded pair makes every nick start at a
//      different x, which is the whole reason vjt asked for it;
//   2. so the nicks LINE UP: same left edge on a visitor row and a user row;
//   3. the network is on its OWN LINE, under the badge+nick pair, not beside
//      it — "column 1, two lines";
//   4. and the badge does not touch the nick.
//
// Assertion 4 is the direct descendant of the glued-cell defect: a zero gap is
// what "shipped without CSS" looks like, in the new markup.
//
// The overflow probe at the bottom is carried over from the old spec, where it
// was explicitly NOT a found defect but a cheap regression guard
// (getBoundingClientRect is the only overflow-aware one). It costs nothing and
// an actual row overflow would trip it.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.

import { adminSessionRowKey, openAdminSessionsTab } from "../fixtures/cicchettoPage";
import { mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

test("admin Sessions view: the kind badges are one width, so the nicks line up", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const visitorNick = `layout-victim-${Date.now()}`;
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

    // Both subject kinds must be on screen for the alignment claim to mean
    // anything: the badges only need padding because "visitor" and "user"
    // differ in length, so a single-kind table would pass trivially.
    const visitorKey = await adminSessionRowKey(page, "visitor", visitor.id);
    const visitorRow = page.getByTestId(`admin-session-row-${visitorKey}`);
    const userRow = page.locator("[data-testid^='admin-session-row-user:']").first();
    await expect(visitorRow).toBeVisible();
    await expect(userRow).toBeVisible({ timeout: 15_000 });
    await expect(visitorRow).toContainText(visitorNick);

    const visitorBadge = visitorRow.locator(".adm-badge--kind");
    const userBadge = userRow.locator(".adm-badge--kind");
    await expect(visitorBadge).toHaveText("visitor");
    await expect(userBadge).toHaveText("user");

    const visitorBadgeBox = await visitorBadge.boundingBox();
    const userBadgeBox = await userBadge.boundingBox();
    const visitorNickBox = await visitorRow.locator(".admin-session-nick").boundingBox();
    const userNickBox = await userRow.locator(".admin-session-nick").boundingBox();
    const identityBox = await visitorRow.locator(".admin-session-identity").boundingBox();
    const networkBox = await visitorRow.locator(".admin-session-network").boundingBox();

    if (
      visitorBadgeBox === null ||
      userBadgeBox === null ||
      visitorNickBox === null ||
      userNickBox === null ||
      identityBox === null ||
      networkBox === null
    ) {
      throw new Error("identity cell parts have no box — the markup or the classes drifted");
    }

    // 1. Same width. Sub-pixel tolerance only: this must be a declared width,
    //    not a coincidence of two words happening to render alike.
    expect(
      Math.abs(visitorBadgeBox.width - userBadgeBox.width),
      "the visitor and user kind badges must be the same width",
    ).toBeLessThanOrEqual(0.5);

    // 2. Therefore the nicks share a left edge. Asserted separately from (1)
    //    because equal badges are the MEANS and the aligned column is the
    //    END: a stray margin on one row would satisfy (1) and break this.
    expect(
      Math.abs(visitorNickBox.x - userNickBox.x),
      "with equal-width badges the nicks must start at the same x",
    ).toBeLessThanOrEqual(0.5);

    // 3. Two lines: the network sits BELOW the badge+nick pair, not beside
    //    it. `.adm-row-expand` is a row-direction flex container, so without
    //    a rule putting this pair on its own axis the network lands on the
    //    same line and this fails.
    expect(
      networkBox.y,
      "the network must be on its own line, under the badge and nick",
    ).toBeGreaterThanOrEqual(identityBox.y + identityBox.height);

    // 4. The glued-cell descendant. Adjacent inline spans with no CSS put the
    //    nick at exactly the badge's right edge; any real gap is > 0.
    expect(
      visitorNickBox.x - (visitorBadgeBox.x + visitorBadgeBox.width),
      "the kind badge must not touch the nick",
    ).toBeGreaterThan(0);

    // Carried-over overflow probe: a row's action control stays inside the
    // row's own box, and in its right half (the actions column). A visitor
    // row offers exactly one of the two verbs, chosen on live truth.
    const action = visitorRow
      .locator("[data-testid^='admin-session-disconnect-']")
      .or(visitorRow.locator("[data-testid^='admin-session-reconnect-']"));
    await expect(action).toBeVisible();
    const rowBox = await visitorRow.boundingBox();
    const actionBox = await action.boundingBox();
    if (rowBox === null || actionBox === null) throw new Error("row or action has no box");
    expect(actionBox.x).toBeGreaterThanOrEqual(rowBox.x - 1);
    expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
    expect(actionBox.x).toBeGreaterThan(rowBox.x + rowBox.width / 2);
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});
