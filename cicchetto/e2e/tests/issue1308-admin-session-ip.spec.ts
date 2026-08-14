// #1308 — the admin Sessions view lost the source address when #1157
// merged Visitors into it. What survived was one detail-panel fact,
// visitor-only, reading `visitors.ip`: identity-wide, written once when
// the visitor was provisioned, and with no user-side twin at all. A user
// row showed no address anywhere.
//
// vjt ruled it (2026-08-14): the fact is `accounts_sessions.ip`, the
// per-session one, it stays in the card, and the table grows no column.
// So the card is not a convenience here — it is the ONLY place this
// reaches an operator, at every width.
//
// jsdom already pins the fact list and the wire (`AdminSessionsTab.test.tsx`,
// `adminSubjectRows.test.ts`, the two controller wire tests). What only a
// real stack shows is that the value is REAL: it travels
// login → `accounts_sessions.ip` → one batched query → two row-backed
// endpoints → the merged row → the card. A jsdom fixture hands the
// renderer a string and proves none of that.
//
// The USER row is the discriminating half. Its card had no `ip` fact to
// begin with, so the label's mere presence there fails on the old code.
// The visitor half is a non-regression witness and nothing more: that
// card always rendered an address, and only the wire tests can tell
// WHICH address it is now.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.

import type { Locator, Page } from "@playwright/test";
import {
  adminSessionRowKey,
  openAdminSessionDetail,
  openAdminSessionsTab,
} from "../fixtures/cicchettoPage";
import { mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin, getSeededVjt } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// An address, of either family, rather than the em-dash the renderer
// prints for "we do not have one". Deliberately NOT a literal: the
// address the container observes depends on how the stack is networked,
// and pinning `127.0.0.1` would be an assertion about docker, not about
// the field.
const AN_ADDRESS = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+)$/i;

/** One fact's value, addressed by its label. The panel renders `upstream`
 * — an address too — so asserting over the whole card's text could not
 * tell the two apart, and telling them apart is the point: `upstream` is
 * the IRC server the bouncer dialled OUT to, not where the client is. */
async function factValue(panel: Locator, label: string): Promise<string | null> {
  return panel.evaluate((el, wanted) => {
    for (const pair of Array.from(el.querySelectorAll(".adm-fact"))) {
      if (pair.querySelector("dt")?.textContent?.trim() === wanted) {
        return pair.querySelector("dd")?.textContent?.trim() ?? null;
      }
    }
    return null;
  }, label);
}

async function loginAsAdmin(page: Page): Promise<void> {
  const admin = getSeededAdmin();
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
}

test("admin Sessions card: the per-session source address, on BOTH subject kinds", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const vjtId = (JSON.parse(getSeededVjt().subjectJson) as { id: string }).id;
  // The mint is the visitor's login, so it is also what writes the
  // session row this card must be reading.
  const visitor = await mintVisitor(`ipvictim-${Date.now()}`);

  try {
    await loginAsAdmin(page);

    // THE half that fails on the old code: a user row had no `ip` fact,
    // so this is a claim about the label existing before it is one about
    // the value.
    const userKey = await adminSessionRowKey(page, "user", vjtId);
    const userPanel = await openAdminSessionDetail(page, userKey);
    const userIp = await factValue(userPanel, "ip");
    expect(userIp, "a user row must carry a source address fact at all").not.toBeNull();
    expect(userIp, "and it must be the address the seeded login came from, not an em-dash").toMatch(
      AN_ADDRESS,
    );

    // It is NOT the upstream peer. Both are on this card and both are
    // addresses; the pair is what makes the labelling load-bearing.
    const upstream = await factValue(userPanel, "upstream");
    expect(upstream, "the upstream fact still renders — it just is not the client").not.toBeNull();
    expect(upstream).not.toBe(userIp);

    const visitorKey = await adminSessionRowKey(page, "visitor", visitor.id);
    const visitorPanel = await openAdminSessionDetail(page, visitorKey);
    expect(
      await factValue(visitorPanel, "ip"),
      "the visitor card kept its address through the swap",
    ).toMatch(AN_ADDRESS);
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});
