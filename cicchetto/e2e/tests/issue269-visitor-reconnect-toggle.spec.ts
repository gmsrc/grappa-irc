// #269 — per-(visitor, network) Disconnect ⇄ Reconnect, in the unified admin
// Sessions view. An operator can tear down a visitor's live session on ONE
// network and bring it back up — per-network, never a global "disconnect
// everywhere".
//
// #1157 changed the control's SHAPE, not the contract. On the deleted Visitors
// tab this was one button whose label flipped; in the unified view the two
// verbs are separate controls and `rowActions` renders exactly one of them,
// chosen on LIVE truth (`row.live === null ? reconnect : disconnect`) and never
// on the DB `connection_state`. So the toggle is now asserted as an EXCHANGE of
// testids rather than a text flip.
//
// Reconnect stays visitor-only, deliberately: the server's
// `ensure_visitor_subject/1` answers 400 for a user subject, because a user
// parks and reconnects their OWN sessions through `PATCH /networks/:id`.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT — only the
// admin user class reaches the console; the reachability gate lives in
// m7-admin-gate-settings-drawer.spec.ts.
//
// Per `feedback_cicchetto_browser_smoke`: this Playwright spec IS the
// browser smoke for #269 — chromium in the e2e harness renders the
// inline-confirm text flip + the control exchange that vitest jsdom can't see.
//
// Per `feedback_ux_e2e_mandatory`: the OUTCOME asserted is the live-pid truth
// flipping per-network, and it is read through TWO independent projections of
// `live_state` so a cosmetic change to either cannot fake a pass: the control
// the operator acts on (disconnect ⇄ reconnect) and the channels cell, which
// renders the em-dash if and ONLY if `live` is null. Disconnect drops the pid;
// Reconnect spawns it back. Not DOM cosmetics: the session genuinely goes down
// then up on the SPECIFIC network.

import { adminSessionRowKey, openAdminSessionsTab } from "../fixtures/cicchettoPage";
import { mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

async function adminOpenSessions(
  page: import("@playwright/test").Page,
  seed: ReturnType<typeof getSeededAdmin>,
): Promise<void> {
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [seed.token, seed.subjectJson] as const,
  );
  await page.goto("/");
  await openAdminSessionsTab(page);
}

test("#269 admin Sessions view Disconnect ⇄ Reconnect toggles a per-network visitor session", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const visitor = await mintVisitor(`i269-victim-${Date.now()}`);

  try {
    await adminOpenSessions(page, admin);

    const key = await adminSessionRowKey(page, "visitor", visitor.id);
    const disconnect = page.getByTestId(`admin-session-disconnect-${key}`);
    const reconnect = page.getByTestId(`admin-session-reconnect-${key}`);
    const channels = page.getByTestId(`admin-session-channels-${key}`);

    // Live on mint: the row offers Disconnect (never Reconnect), and the
    // channels cell carries a count rather than the no-pid em-dash.
    await expect(disconnect).toHaveText(/^Disconnect$/, { timeout: 15_000 });
    await expect(reconnect).toHaveCount(0);
    await expect(channels).toHaveText(/^\d+$/);

    // Disconnect (inline-confirm two-step): tear the pid down on THIS
    // network. Visitor disconnect collapses to terminate; the refetch then
    // reports live_state: null, so the control is REPLACED by Reconnect and
    // the channels cell falls back to the em-dash.
    //
    // The row itself must SURVIVE — that is the whole point of the #1157
    // row-backed merge. A registry-driven list would drop the visitor here
    // and there would be nothing left to press Reconnect on.
    await disconnect.click();
    await expect(disconnect).toHaveText(/^Confirm disconnect$/);
    await expect(disconnect).toHaveClass(/confirming/);
    await disconnect.click();

    await expect(reconnect).toHaveText(/^Reconnect$/, { timeout: 15_000 });
    await expect(disconnect).toHaveCount(0);
    await expect(channels).toHaveText("—");
    await expect(page.getByTestId("admin-sessions-error")).toHaveCount(0);

    // Reconnect (inline-confirm two-step): spawn the session back on THIS
    // network. Both projections return to their live readings.
    await reconnect.click();
    await expect(reconnect).toHaveText(/^Confirm reconnect$/);
    await expect(reconnect).toHaveClass(/confirming/);
    await reconnect.click();

    await expect(disconnect).toHaveText(/^Disconnect$/, { timeout: 15_000 });
    await expect(reconnect).toHaveCount(0);
    await expect(channels).toHaveText(/^\d+$/);
    await expect(page.getByTestId("admin-sessions-error")).toHaveCount(0);
  } finally {
    // Idempotent cleanup — Operator.delete_visitor stops every live
    // session + deletes the row, so a downed OR live victim is fully
    // reaped and never poisons a downstream spec.
    await reapVisitors(admin.token, visitor.id);
  }
});
