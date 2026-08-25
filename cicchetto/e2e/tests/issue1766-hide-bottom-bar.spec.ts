// GH #1766 — a per-user setting that hides the mobile BottomBar.
//
// vjt, `#grappa` 2026-08-25: *"aggiungiamo setting toggle per disattivare la
// bottom bar su mobile. ora sono su 7 reti ed e' diventata praticamente
// inutile"*. The bar is a flat horizontal strip of EVERY window across EVERY
// network — O(windows), not O(screens) — so past a handful of networks it is
// longer than the useful scroll distance and the picker stops picking.
//
// Default stays ON. #174 closed with the ruling that the bar must NOT be
// deleted, only made opt-in from settings; #71's second ruling reversed "kill
// the mobile bottom bar" outright. This is the opt-out those two asked for.
//
// ## What this file has to prove that the unit tests cannot
//
// The unit suite pins the JSX gate and the child order in jsdom, where there is
// no layout, no service worker, no server and no second page load. Three claims
// need a real browser and a real bouncer:
//
//   1. The bar actually LEAVES the phone. A `<Show>` that renders nothing in
//      jsdom still tells you nothing about a strip that is `position`-ed by a
//      stylesheet jsdom never applies.
//   2. Something navigable replaces it. That is the whole reason the ☰ ships
//      with the toggle: #1041's left-edge swipe is gesture-only with zero
//      affordance, which is the drawer-only navigation #71 refused as a
//      default. So the test does not stop at "the ☰ is in the DOM" — it taps
//      it and CHANGES WINDOW through the drawer it opens. A ☰ that renders and
//      navigates nowhere would pass a presence assertion.
//   3. The preference is ACCOUNT-scoped, not device-scoped. It sits in the
//      #449 synced `display_prefs` and not in localStorage alone, deliberately
//      and against the counter-precedent of its own neighbour in the settings
//      fieldset (#914's per-device `hide_next_active`). Only a round trip
//      through the server can tell the two apart, so the second test wipes the
//      local mirror and reloads: if the bar comes back, the pref was never
//      synced and the "7 networks is an account property" argument was not
//      implemented.
//
// `@webkit` throughout: the bar renders on the mobile branch only, so a
// chromium run would assert the absence of something that was never there.

import {
  closeSettings,
  loginAs,
  openSettingsSection,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

const BOTTOM_BAR = ".bottom-bar";
const WINDOWS_OPENER = "open windows sidebar";
// The two localStorage keys that make up the LOCAL half of the preference: the
// owner module's boot mirror and the coordinator's "a PUT never ACKed" marker.
// Both have to go, or the reload below re-pushes the local value instead of
// letting the server answer — which is the #222 re-push arm doing its job, and
// would make the test prove the opposite of what it claims.
const LOCAL_MIRROR_KEYS = ["cicchetto.showBottomBar", "cic.displayPrefs.unsynced"];

test.setTimeout(90_000);

async function hideTheBar(page: Parameters<typeof loginAs>[0]): Promise<void> {
  await openSettingsSection(page, "display");
  const toggle = page.getByTestId("show-bottom-bar-toggle");
  // Checked by DEFAULT: the bar ships shown. If this is already unchecked the
  // rest of the test would pass against a build whose default is inverted.
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await closeSettings(page);
}

test("@webkit mobile: turning the bar off removes it and leaves a working door", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // Baseline: the bar is there, and there is exactly ONE ☰ — the members door
  // on the right. No left door while the picker is in flow.
  await expect(page.locator(BOTTOM_BAR)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByLabel(WINDOWS_OPENER)).toHaveCount(0);

  await hideTheBar(page);

  // 1. The bar is GONE from the page, not merely hidden: the gate is a mount
  //    gate, because a CSS-hidden BottomBar would keep running #327's
  //    double-rAF scroll-into-view against a strip nobody can see.
  await expect(page.locator(BOTTOM_BAR)).toHaveCount(0, { timeout: 10_000 });

  // 2. …and the left ☰ has arrived to replace it.
  const opener = page.getByLabel(WINDOWS_OPENER);
  await expect(opener).toBeVisible({ timeout: 10_000 });

  // 3. THE assertion. Tap it, and NAVIGATE — the drawer it opens is the #1041
  //    channel sidebar, and picking the server window from it must actually
  //    move the pane. A door that opens onto nothing would satisfy every
  //    assertion above.
  await opener.tap();
  const sidebar = page.locator(".shell-sidebar");
  await expect(sidebar).toBeVisible({ timeout: 10_000 });

  await sidebar.locator('[data-window-name="$server"]').first().tap();
  // The server window has no topic bar; the scrollback pane retargeting is the
  // observable move. Assert the CHANNEL bar is gone rather than that some pane
  // exists — the latter is true before the tap too.
  await expect(page.locator(".topic-bar-channel")).toHaveCount(0, { timeout: 10_000 });

  // The rail is still reachable with the bar off — settings must not become
  // unreachable as a side effect of hiding the navigation strip.
  await openSettingsSection(page, "display");
  await expect(page.getByTestId("show-bottom-bar-toggle")).not.toBeChecked();
});

test("@webkit mobile: the preference is remembered by the ACCOUNT, not the device", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(page.locator(BOTTOM_BAR)).toBeVisible({ timeout: 10_000 });

  await hideTheBar(page);
  await expect(page.locator(BOTTOM_BAR)).toHaveCount(0, { timeout: 10_000 });

  // Wipe the LOCAL half only — the bearer stays, so this is the same account
  // arriving on a device that has never seen the preference. (A blanket
  // `localStorage.clear()` would take the session with it and prove nothing.)
  await page.evaluate((keys: string[]) => {
    for (const k of keys) localStorage.removeItem(k);
  }, LOCAL_MIRROR_KEYS);
  await page.reload();

  // On boot the owner module reads its empty mirror and defaults to SHOWN, so
  // the bar may flash in before the login reconcile lands. `toHaveCount(0)`
  // with a timeout is the honest oracle: it polls, and what it settles on is
  // the server's answer.
  await expect(page.locator(BOTTOM_BAR)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByLabel(WINDOWS_OPENER)).toBeVisible({ timeout: 10_000 });
});
