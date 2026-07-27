// #481 — a USER (not a visitor) self-connects an available network from the
// home page. The visitor-only premise on the "available to connect" tier was
// a #461 relic; three gates enforced it (empty server payload for users, a
// 403 write verb, and the client section). This spec proves the FEATURE
// end-to-end in the browser: a user one-taps an available `visitor_enabled`
// network and it connects LIVE.
//
// The dedicated `accr481` user (NO network bind — seeded in compose.yaml)
// logs in via the loginAs seam, so home renders the self-serve state. It
// one-taps azzurra2, which points at SOLANUM (bahamut-test2) — an
// INDEPENDENT nick namespace, so the shared-leaf 433 trap
// (feedback_e2e_multinet_live_needs_distinct_nicks) never fires on the fresh
// dial. The visible outcome: azzurra2's network section appears LIVE in the
// sidebar. It started AVAILABLE (not attached), so its appearance = the
// accretion bound a USER credential + spawned + connected it.
//
// Server-side correctness (visitor_enabled bound holds for users, a USER
// credential is bound, the spawn rides the user connect capacity path) is
// pinned RED-first in test/grappa_web/controllers/session_controller_test.exs
// + test/grappa/networks_test.exs; this is the real browser end-to-end.
//
// Isolation: `accr481` is used by NO other spec, so the live azzurra2
// session it leaves has zero blast radius (the azzurra2 visitor-cap pool is
// subject-kind-separate from this USER session, U-1 split). Non-destructive
// → no cleanup needed.

import { expect, test } from "@playwright/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { ACCRETE_NETWORK_SLUG, getSeededAccreteUser } from "../fixtures/seedData";

test.describe("#481 user self-serve accretion", () => {
  test("a USER one-taps an available network from home and it connects live", async ({ page }) => {
    const user = getSeededAccreteUser();
    // accr481 holds NO network → home renders the self-serve empty state
    // (noNetworks: true waits on the registered home pane, not a sidebar
    // network header that does not exist yet).
    await loginAs(page, user, { noNetworks: true });

    // #481 — the self-serve "available to connect" section renders for a
    // USER now (it was visibly present only for visitors before).
    await expect(page.getByTestId("home-available")).toBeVisible();
    const connectBtn = page.getByTestId(`home-available-connect-${ACCRETE_NETWORK_SLUG}`);
    await expect(connectBtn).toBeVisible();

    // One-tap → POST /session/networks → bind a USER credential + spawn.
    await connectBtn.click();

    // Visible outcome: azzurra2 appears LIVE in the sidebar. "azzurra2" is an
    // unambiguous hasText (not a substring of another seeded slug). Generous
    // timeout: a cold dial + registration against solanum. Its appearance
    // proves the one-tap CONNECTED — it was AVAILABLE, not attached, at login.
    await expect(
      page.locator(".sidebar-network-header").filter({ hasText: ACCRETE_NETWORK_SLUG }),
    ).toBeVisible({ timeout: 30_000 });
  });
});
