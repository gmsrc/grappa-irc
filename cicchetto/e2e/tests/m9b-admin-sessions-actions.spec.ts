// M-cluster M-9b — admin Sessions tab end-to-end: list + per-row
// Disconnect + Terminate actions + 422 self-protection.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT —
// only the admin user class reaches the tab; the gate spec lives at
// m7-admin-gate-settings-drawer.spec.ts.
//
// Per `feedback_cicchetto_browser_smoke`: this Playwright spec IS
// the browser smoke for M-9b — chromium in the e2e harness renders
// the two-button-per-row inline-confirm CSS class flips that vitest
// jsdom can't see.
//
// Pre-seed pattern (per `feedback_visitor_mint_e2e_cold_start`):
// the m9b-test user + bind is in the seeder sidecar (compose.yaml),
// NOT minted at test time. Bootstrap spawns its Session.Server at
// grappa-test boot so the row is visible in /admin/sessions by the
// time the spec runs.
//
// Self-disconnect protection: admin-vjt has NO network bind in the
// seeder, so it has NO row in /admin/sessions. The 422
// `cannot_disconnect_self` server gate is therefore unreachable from
// this spec — every visible row belongs to vjt or m9b-test, both
// non-admin. The unit-level coverage for the 422 surface lives in
// AdminSessionsTab.test.tsx ("surfaces a 422 cannot_disconnect_self
// error inline prefixed with the verb"). Adding a Playwright case
// would require seeding admin-vjt with a network bind, which would
// in turn double the admin-vjt session footprint and complicate
// every other admin spec — out of scope here.

import { expect, test } from "@playwright/test";
import { adminLogin, openAdminSessionsTab } from "../fixtures/cicchettoPage";
import { patchNetworkConnectionState } from "../fixtures/grappaApi";
import {
  getSeededAdmin,
  getSeededM9bSessionId,
  getSeededM9bVictim,
  getSeededVjt,
  getSeededWizUser,
  M9B_USER,
  M9B_VICTIM_USER,
  NETWORK_SLUG,
  VJT_USER,
  WIZ_USER,
} from "../fixtures/seedData";

// E2E-ROBUSTNESS bucket D — cascade root fix. The Disconnect spec
// parks m9b-victim's credential and the Terminate spec stops its pid;
// without a cleanup hook the session stays dead for the remainder of
// the chromium suite, causing 30s timeout cascades in every downstream
// spec that depends on a live m9b-victim (push specs, marker specs,
// P-cluster, UX-5/UX-6 fan-out — 36+ specs total in the baseline).
//
// PATCH connection_state:"connected" is idempotent: no-op if already
// connected, respawn via Networks.connect/1 if parked or terminated.
// Runs after EVERY spec in this file — overkill for tests 1+2 but the
// guarantee matters more than the wasted PATCH.
test.afterEach(async () => {
  const victim = getSeededM9bVictim();
  await patchNetworkConnectionState(victim.token, NETWORK_SLUG, {
    connection_state: "connected",
  });
});

// A subject's id, however the fixture happens to carry it: the two m9b
// users expose a composite `user:<id>:<network>` session id, vjt and
// wiz-test expose the persisted subject JSON. Both reduce to the id, which
// is what a row's testid is keyed on.
function idFromSessionId(sessionId: string): string {
  const parts = sessionId.split(":");
  if (parts.length !== 3) throw new Error(`unexpected session id shape: ${sessionId}`);
  return parts[1];
}

function idFromSubjectJson(subjectJson: string): string {
  const subject = JSON.parse(subjectJson) as { id?: string };
  if (typeof subject.id !== "string") {
    throw new Error(`seeded subject carries no id: ${subjectJson}`);
  }
  return subject.id;
}

test("M-9b admin Sessions view lists every seeded user bind", async ({ page }) => {
  // The four users the seeder binds. wiz-test is on azzurra-reg rather than
  // bahamut-test, so its row's network id is not 1 — which is why each is
  // matched on the `user:<id>:` prefix instead of a full composite key.
  const seeded = [
    { name: VJT_USER, id: idFromSubjectJson(getSeededVjt().subjectJson) },
    { name: M9B_USER, id: idFromSessionId(getSeededM9bSessionId()) },
    { name: M9B_VICTIM_USER, id: idFromSessionId(getSeededM9bVictim().sessionId) },
    { name: WIZ_USER, id: idFromSubjectJson(getSeededWizUser().subjectJson) },
  ];

  await adminLogin(page, getSeededAdmin());
  await openAdminSessionsTab(page);

  // This asserted an EXACT total, and #1157 took that away twice over.
  //
  // Registry-driven, the list held live pids, so a total of 4 meant "the
  // four seeded binds are up" and a drop caught one that failed to connect.
  // Row-backed, a parked or failed subject keeps its row, so the total stops
  // watching connectivity — that half moved to the destructive specs below,
  // which read it off the channels cell.
  //
  // Then the full suite showed the total is not this spec's to own at all.
  // It read 6 where a scoped run read 4, and narrowing to `user:` rows did
  // NOT fix it: the extra two are users, not stray visitors — other specs
  // create accounts with binds and this one runs in the middle of them. Any
  // exact total here reports on the rest of the suite's lifecycle and calls
  // it a regression in the admin console.
  //
  // So it asserts what it was named for: every seeded bind is LISTED, each
  // one addressed and failing under its own name. The half deliberately
  // given up is "no unexpected credential exists" — that population belongs
  // to whichever spec created it, and pretending otherwise is what made this
  // assertion order-dependent.
  for (const subject of seeded) {
    await expect(
      page.locator(`[data-testid^='admin-session-row-user:${subject.id}:']`),
      `${subject.name} must have a row in the unified Sessions view`,
    ).toHaveCount(1, { timeout: 15_000 });
  }
});

test("#242 admin Sessions tab shows the network slug (not the raw network_id FK)", async ({
  page,
}) => {
  // Reconnect the sacrificial victim so its row is guaranteed live
  // (idempotent if already :connected) — every seeded session is bound
  // to bahamut-test, so the network cell of ANY row must render that
  // slug. We target the victim's row deterministically via its
  // composite session id.
  const victim = getSeededM9bVictim();
  await patchNetworkConnectionState(victim.token, NETWORK_SLUG, {
    connection_state: "connected",
  });

  await adminLogin(page, getSeededAdmin());
  await openAdminSessionsTab(page);

  const victimRow = page.getByTestId(`admin-session-row-${victim.sessionId}`);
  await expect(victimRow).toBeVisible({ timeout: 15_000 });

  // #1157 folded the network out of its own column and onto the identity
  // cell's second line, so the by-position probe this spec used ("the 3rd
  // td") no longer addresses it. The class is the replacement, and it keeps
  // the property that made the position probe worth having: the assertion is
  // on the VALUE, so a RED run where the slug resolution is stripped still
  // fails on content — pre-fix the cell renders the raw integer FK ("1"),
  // post-fix the resolved slug ("bahamut-test").
  const networkCell = victimRow.locator(".admin-session-network");
  await expect(networkCell).toHaveText(NETWORK_SLUG, { timeout: 10_000 });
});

// The pre-#1157 version of this spec took `.first()` row and required it
// to carry BOTH buttons. Neither half survives the merge: the unified view
// orders visitors before users, and a visitor row offers exactly one verb
// (`rowActions` — Reconnect is visitor-only, Terminate is not offered), so
// `.first()` would now address a row with no Terminate at all. The mutex is
// a property of a row that has two armable controls, which means a USER row,
// so it is asserted on the same dedicated victim the destructive specs use.
//
// The declaration-order constraint this spec used to carry is GONE. It read:
// "MUST run BEFORE the destructive specs, which leave the DB with sessions
// parked / pids stopped, so this one would see no sessions". That was a
// property of a registry-driven list. The list is row-backed now — a parked
// credential keeps its row, buttons and all — so the ordering no longer
// matters. Left in place regardless: moving it would be churn, not a fix.
test("M-9b arming Disconnect on one row disarms the same row's Terminate (single mutex)", async ({
  page,
}) => {
  const victim = getSeededM9bVictim();

  await adminLogin(page, getSeededAdmin());
  await openAdminSessionsTab(page);

  const disc = page.getByTestId(`admin-session-disconnect-${victim.sessionId}`);
  const term = page.getByTestId(`admin-session-terminate-${victim.sessionId}`);
  await expect(term).toHaveText(/^Terminate$/, { timeout: 15_000 });

  await term.click();
  await expect(term).toHaveText(/^Confirm terminate$/);
  await expect(disc).toHaveText(/^Disconnect$/);

  await disc.click();
  await expect(disc).toHaveText(/^Confirm disconnect$/);
  await expect(term).toHaveText(/^Terminate$/);
});

test("M-9b admin Disconnect inline-confirm transitions Disconnect → Confirm disconnect → fires", async ({
  page,
}) => {
  // GREEN-CI batch-1 — target m9b-victim's row deterministically (NOT
  // `.first()` which is Registry-insertion-order non-deterministic and
  // was killing vjt's session, cascading sidebar-empty failures across
  // every downstream vjt-using spec). Reconnect m9b-victim first
  // (idempotent if already :connected) so the row is guaranteed live;
  // Disconnect parks the credential and the row drops on the next
  // refetch.
  const victim = getSeededM9bVictim();
  await patchNetworkConnectionState(victim.token, NETWORK_SLUG, {
    connection_state: "connected",
  });

  await adminLogin(page, getSeededAdmin());
  await openAdminSessionsTab(page);

  const victimDisconnect = page.getByTestId(`admin-session-disconnect-${victim.sessionId}`);
  await expect(victimDisconnect).toHaveText(/^Disconnect$/, { timeout: 15_000 });

  await victimDisconnect.click();
  await expect(victimDisconnect).toHaveText(/^Confirm disconnect$/);
  await expect(victimDisconnect).toHaveClass(/confirming/);

  await victimDisconnect.click();
  // Post-disconnect: the table re-fetches (runAction does). The target
  // user's credential transitions to :parked and the Bootstrap pid stops.
  //
  // Pre-#1157 the row DROPPED here — the list was registry-driven — so the
  // only thing left to assert was the absence of an error banner, which is
  // not an outcome. Row-backed, the row survives its own pid, so the verb
  // now has a real oracle: the channels cell falls to the em-dash, which
  // `renderChannels` emits if and only if `live` is null. A disconnect that
  // silently no-opped would keep a count there and fail this.
  await expect(page.getByTestId(`admin-session-row-${victim.sessionId}`)).toBeVisible();
  await expect(page.getByTestId(`admin-session-channels-${victim.sessionId}`)).toHaveText("—", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("admin-sessions-error")).toHaveCount(0, { timeout: 5_000 });
});

test("M-9b admin Terminate inline-confirm fires DELETE", async ({ page }) => {
  // GREEN-CI batch-1 — same victim, same reconnect dance. Disconnect
  // (above) parked m9b-victim's credential; reconnect-via-PATCH spawns
  // a fresh Session.Server and the row reappears in /admin/sessions.
  // Terminate then stops the pid (DB row preserved per M-9a contract).
  const victim = getSeededM9bVictim();
  await patchNetworkConnectionState(victim.token, NETWORK_SLUG, {
    connection_state: "connected",
  });

  await adminLogin(page, getSeededAdmin());
  await openAdminSessionsTab(page);

  const victimTerminate = page.getByTestId(`admin-session-terminate-${victim.sessionId}`);
  await expect(victimTerminate).toHaveText(/^Terminate$/, { timeout: 15_000 });

  await victimTerminate.click();
  await expect(victimTerminate).toHaveText(/^Confirm terminate$/);
  await expect(victimTerminate).toHaveClass(/confirming/);

  await victimTerminate.click();
  // 204 idempotent. Pid is gone; DB rows preserved (per M-9a spec) — and
  // since #1157 the LIST preserves them too, so "DB row preserved, pid
  // gone" is finally assertable from the console instead of being a claim
  // about a row that vanished: the row stays, the channels cell reads the
  // no-pid em-dash.
  await expect(page.getByTestId(`admin-session-row-${victim.sessionId}`)).toBeVisible();
  await expect(page.getByTestId(`admin-session-channels-${victim.sessionId}`)).toHaveText("—", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("admin-sessions-error")).toHaveCount(0, { timeout: 5_000 });
});
