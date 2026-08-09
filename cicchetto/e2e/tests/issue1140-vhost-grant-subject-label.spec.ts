// #1140 — the vhost grants table printed the bare subject UUID. The
// operator picks a grant subject BY NAME in the #257 autocomplete, so
// after the post-grant refresh they could not tell WHICH of their users
// held the grant without resolving the GUID by hand.
//
// The label is resolved SERVER-side (`subject_label` on the grant wire):
// the grants list arrives with the vhosts payload and has no search
// round-trip to piggyback on. `subject_label: null` is the honesty signal
// for a subject that resolves to no name; cic then falls back to the uuid
// rather than inventing a placeholder.
//
// The RED here is behavioural, not structural: before #1140 the subject
// cell rendered the uuid as its TEXT and carried no title, so both
// assertions below fail on the old build.
//
// The subject flow through the autocomplete is #257's spec; this one
// seeds the grant through the API and asserts what the TABLE says, which
// is the part #1140 reports as broken. DESKTOP admin surface → chromium.
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated is EXEMPT.

import { expectShellReady, openAdminConsole } from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

async function createVhost(token: string, address: string): Promise<number> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/vhosts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ address, in_pool: false, generally_available: false }),
  });
  if (!res.ok) throw new Error(`createVhost: ${address} → ${res.status}`);
  const body = (await res.json()) as { id: number };
  return body.id;
}

async function grantToUser(token: string, vhostId: number, userId: string): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/vhosts/${vhostId}/grants`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ subject_type: "user", subject_id: userId }),
  });
  if (!res.ok) throw new Error(`grantToUser: ${vhostId} → ${res.status}`);
}

async function deleteVhostBestEffort(token: string, id: number): Promise<void> {
  try {
    await fetch(`${GRAPPA_BASE_URL}/admin/vhosts/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort teardown; grants cascade with the vhost
  }
}

test("#1140 — the grants table names the subject and demotes its uuid to the title", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const adminId = (JSON.parse(admin.subjectJson) as { id: string }).id;
  const address = `2001:db8:1140::${(Date.now() % 0xffff).toString(16)}`;

  let vhostId: number | null = null;

  try {
    // The account name and the stable key must be distinguishable, else
    // "shows the name, not the uuid" proves nothing.
    expect(adminId).not.toBe(admin.name);

    vhostId = await createVhost(admin.token, address);
    await grantToUser(admin.token, vhostId, adminId);

    await page.addInitScript(
      ([token, subjectJson]) => {
        localStorage.setItem("grappa-token", token);
        localStorage.setItem("grappa-subject", subjectJson);
        localStorage.setItem("cic.installChoice", "browser");
      },
      [admin.token, admin.subjectJson] as const,
    );
    await page.goto("/");
    await expectShellReady(page);

    await openAdminConsole(page);
    await page.getByTestId("admin-tab-vhosts").click();
    await expect(page.getByTestId("admin-vhosts-table")).toBeVisible({ timeout: 10_000 });

    const grantsTable = page.getByTestId(`admin-vhost-grants-table-${vhostId}`);
    await expect(grantsTable).toBeVisible({ timeout: 10_000 });

    // The subject cell reads as a human: the account name, resolved by the
    // server, with the uuid nowhere in the visible text.
    const subjectCell = grantsTable.locator("[data-testid^='admin-vhost-grant-subject-']").first();
    await expect(subjectCell).toHaveText(admin.name);
    await expect(subjectCell).not.toContainText(adminId);

    // …and the stable key is still one hover away — it did not leave the
    // wire, it left the reading order.
    await expect(subjectCell).toHaveAttribute("title", adminId);
  } finally {
    if (vhostId !== null) await deleteVhostBestEffort(admin.token, vhostId);
  }
});
