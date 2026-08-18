// #1073 — the admin console's top bar IS the channel windows' bar, with live
// key stats in its left group.
//
// What this spec is for, and what it deliberately is not: the vitest suites
// already pin the wiring (`adminOverview.test.ts` — the push, the snapshot
// semantics, the nullable loadavg; `AdminPane.test.tsx` — the stats mounted in
// the bar's content slot). None of that proves the bar READS right, because
// jsdom computes no layout and the constraint vjt and Hypnotize actually set
// is a layout one: *"si, non invadente"*, *"deve essere piccola, che già la
// tastiera occupa una madonna"*. Per `feedback_cicchetto_browser_smoke` this
// spec is the browser smoke for the two facts only a real engine can settle —
// the row does not wrap, and the ☰ stays at the far end of it — plus the one
// end-to-end fact no unit can reach: the numbers come off a LIVE server push,
// not a fixture.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated, the EXEMPT shape —
// only the admin class reaches this surface at all, and the gate itself is
// asserted at m7-admin-gate-settings-drawer.
//
// The stats' visibility IS the barrier. `AdminOverviewStats` renders nothing
// until the first `"overview"` push lands, so `toBeVisible()` waits on the
// arrival of real server data rather than on a timer.

import { adminLogin, openAdminConsole } from "../fixtures/cicchettoPage";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// admin-vjt has no network bind, so `loginAs`'s network-section shell-ready
// selector would time out. Same shape as m7-admin-gate / m11-admin-events.
const CELLS = [
  "admin-overview-sessions",
  "admin-overview-visitors",
  "admin-overview-hostname",
  "admin-overview-loadavg",
  "admin-overview-version",
] as const;

// The five cells share one text line iff their boxes share one top edge.
// Tops rather than heights: a cell's height varies with its own glyph (the ⚡
// and the 👤 are not the digits' size), so equal heights would prove nothing
// and unequal heights would prove nothing either. Sub-pixel layout is real, so
// compare within 1px rather than exactly.
async function expectOneLine(pane: import("@playwright/test").Locator): Promise<void> {
  let first: number | null = null;
  for (const id of CELLS) {
    const box = await pane.getByTestId(id).boundingBox();
    expect(box, `${id} must have a layout box`).not.toBeNull();
    const top = (box as { y: number }).y;
    if (first === null) {
      first = top;
      continue;
    }
    expect(Math.abs(top - first), `${id} must sit on the same line as the first cell`).toBeLessThan(
      1.5,
    );
  }
}

test("#1073 the admin bar carries live stats, on one line, in the shared band", async ({
  page,
}) => {
  await adminLogin(page, getSeededAdmin());
  const pane = await openAdminConsole(page);

  // Barrier AND assertion: nothing renders until the server's first push.
  const stats = pane.locator(".topic-bar .admin-overview-stats");
  await expect(stats).toBeVisible({ timeout: 10_000 });

  // The numbers are the SERVER's, so the spec asserts their shape rather than
  // their value — a bound value would be asserting the seed, not the wire.
  await expect(pane.getByTestId("admin-overview-sessions")).toHaveText(/\d/);
  await expect(pane.getByTestId("admin-overview-visitors")).toHaveText(/\d+\/\d+/);
  await expect(pane.getByTestId("admin-overview-version")).toHaveText(/^v\d+\.\d+\.\d+/);
  await expect(pane.getByTestId("admin-overview-hostname")).not.toHaveText("");

  // The loadavg's two correctness rules, as they reach a real screen. It is
  // the HOST's load (the jail shares the host kernel), so the word is on the
  // cell and not only in a tooltip; and an unreachable sampler renders as an
  // em dash with NO digit, because `0.00` would report a calm machine that
  // nobody can actually see. Both readings are legal here — CI may or may not
  // have `:cpu_sup` — and the alternation is the point: what is illegal is a
  // bare unlabelled number, or a fabricated zero.
  await expect(pane.getByTestId("admin-overview-loadavg")).toHaveText(/^host (—|\d+\.\d{2})$/);

  // ONE LINE. The whole reason the row clips instead of wrapping.
  await expectOneLine(pane);

  // The band is the shared one and stayed a band: no × (deleted — the rail's
  // `home` row is the exit) and no refresh glyph (moved into the rail).
  await expect(pane.locator(".admin-pane-header")).toHaveCount(0);
  await expect(page.getByTestId("admin-pane-close")).toHaveCount(0);
  await expect(pane.locator(".topic-bar [data-testid$='-refresh']")).toHaveCount(0);
});

test("#1073 @webkit on a phone the stats keep the ☰ at the far end", async ({ page }) => {
  await adminLogin(page, getSeededAdmin());
  const pane = await openAdminConsole(page);

  const stats = pane.locator(".topic-bar .admin-overview-stats");
  await expect(stats).toBeVisible({ timeout: 10_000 });

  // 393px is where the constraint bites: title + five stats + ☰ on one line.
  // The ☰'s side is meant to be a consequence of it being the bar's LAST
  // child, not of an override — so the failing shape to catch is the stats
  // pushing it out of the bar, or off the screen entirely.
  const hamburger = pane.locator(".topic-bar-hamburger");
  await expect(hamburger).toBeVisible();
  await expect(hamburger).toBeInViewport({ ratio: 1 });

  const statsBox = await stats.boundingBox();
  const hamBox = await hamburger.boundingBox();
  expect(statsBox).not.toBeNull();
  expect(hamBox).not.toBeNull();
  const s = statsBox as { x: number; width: number };
  const h = hamBox as { x: number };
  expect(h.x).toBeGreaterThanOrEqual(s.x + s.width - 1);

  // Still one line at phone width — the case the desktop test cannot make.
  await expectOneLine(pane);
});
