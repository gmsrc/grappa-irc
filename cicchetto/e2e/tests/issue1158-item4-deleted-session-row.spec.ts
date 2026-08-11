// #1158 item 4 — an operator must be able to see a session that is over,
// including one whose subject no longer exists.
//
// vjt ruled the retention fork on 2026-08-11 ("tutto giusto conserviamo
// solo l'evento"): visitor retention is UNCHANGED — an anon visitor is
// still purged at logout and reaped at TTL, and the co-terminal identity
// contract stands. What survives is the EVENT: `session_log_events` (#215)
// carries no FK to the subject, so the CASCADE that destroys the visitor
// leaves the lifecycle rows behind. Those rows are keyed on the same
// `<kind>:<id>:<network>` composite the admin session rows are, which is
// what makes the unified Sessions view able to list them.
//
// What this spec pins is the SURFACE contract, in the one direction the
// product actually promises:
//
//     given the log remembers a session, and no subject row does,
//     the Sessions view lists it, marks it deleted, and offers no verb.
//
// It deliberately does NOT assert the converse. The log is a bounded
// global ring written from an async telemetry cast on a path that
// includes `terminate/2`, so a MISSING entry is forgetfulness, not
// evidence a session never ran. That is why the log entry is established
// as a PRECONDITION (polled off the API before the delete) rather than
// assumed after it: the barrier failing means the sink did not record,
// which is a different fact from the surface being wrong, and the spec
// says which one it hit.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT — only
// the admin class reaches the console, and reachability for the other
// two is covered by `m7-admin-gate-settings-drawer.spec.ts`.

import { openAdminSessionDetail, openAdminSessionsTab } from "../fixtures/cicchettoPage";
import { listSessionLogSessions, mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

test("#1158 item 4 a deleted visitor's session survives as a log-only row with no verbs", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const visitorNick = `i1158-ghost-${Date.now()}`;
  const visitor = await mintVisitor(visitorNick);
  let deleted = false;

  try {
    // PRECONDITION, not the property: wait until the sink has actually
    // written this session's lifecycle row. Everything below is about
    // what the surface does GIVEN that row exists.
    const sessionIdPrefix = `visitor:${visitor.id}:`;
    await expect
      .poll(
        async () => {
          const entries = await listSessionLogSessions(admin.token);
          return entries.filter((e) => e.session_id.startsWith(sessionIdPrefix)).length;
        },
        {
          timeout: 20_000,
          message: `precondition: session_log never recorded ${sessionIdPrefix}* — the sink did not write, so the surface under test cannot be driven`,
        },
      )
      .toBeGreaterThan(0);

    const [logged] = (await listSessionLogSessions(admin.token)).filter((e) =>
      e.session_id.startsWith(sessionIdPrefix),
    );
    if (logged === undefined) throw new Error("precondition vanished between poll and read");
    const key = logged.session_id;

    // Destroy the identity through the operator verb the ruling leaves
    // untouched. After this there is no visitor row, no credential and
    // no pid — only the event.
    await reapVisitors(admin.token, visitor.id);
    deleted = true;

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

    // THE property. Without the log join this row cannot exist at all:
    // both row-backed endpoints lost the subject with the CASCADE.
    const row = page.getByTestId(`admin-session-row-${key}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(visitorNick);

    // Marked, so it does not read as a live session that merely looks
    // broken — the operator must be able to tell "gone" from "down".
    await expect(page.getByTestId(`admin-session-gone-${key}`)).toBeVisible();

    // No credential to park, no pid to stop: every verb would resolve to
    // a subject that is gone, so none is offered. Asserting all three
    // matters — a single surviving button is a guaranteed failed request.
    await expect(page.getByTestId(`admin-session-disconnect-${key}`)).toHaveCount(0);
    await expect(page.getByTestId(`admin-session-reconnect-${key}`)).toHaveCount(0);
    await expect(page.getByTestId(`admin-session-terminate-${key}`)).toHaveCount(0);
    await expect(page.getByTestId(`admin-session-delete-${key}`)).toHaveCount(0);

    // The dictated shape: the row stays a summary, the record lives in
    // the drill-in ("nei dettagli mostrare tutte le info", vjt 2026-08-11).
    // Not `logged.event`: terminating the session can append a newer
    // lifecycle row between the barrier and the render, so the stable
    // claim is that the panel names the log as the record, and carries a
    // last-event fact at all.
    const detail = await openAdminSessionDetail(page, key);
    await expect(detail).toContainText("session log only");
    await expect(detail).toContainText("last event");
  } finally {
    if (!deleted) await reapVisitors(admin.token, visitor.id);
  }
});
