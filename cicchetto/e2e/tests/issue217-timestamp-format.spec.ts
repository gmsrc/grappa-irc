// #217 — message-row timestamp format is user-configurable from Settings,
// defaulting to WITH seconds (HH:MM:SS). Switching the format re-renders the
// open scrollback live (the format is a Solid signal, not a boot-time DOM
// write), and the choice persists across a reload (localStorage).
//
// Desktop project (untagged → chromium). Uses the seeded #spec-wN scrollback so
// there is always at least one message row carrying a `.scrollback-time` cell.

import {
  closeSettings,
  loginAs,
  openSettingsSection,
  scrollbackLines,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// The first rendered message row's timestamp text.
const HMS_RE = /^\d{2}:\d{2}:\d{2}$/;
const HM_RE = /^\d{2}:\d{2}$/;

async function firstTimeCell(page: import("@playwright/test").Page) {
  return scrollbackLines(page).first().locator(".scrollback-time").first();
}

test("#217 — timestamp format defaults to seconds, toggles live from Settings, persists", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // At least one message row is present (seeded #spec-wN).
  await expect.poll(async () => await scrollbackLines(page).count()).toBeGreaterThan(0);

  // Default (no stored preference) → WITH seconds.
  const timeCell = await firstTimeCell(page);
  await expect(timeCell).toHaveText(HMS_RE);

  // Open Settings → display sub-page (#460), confirm the with-seconds radio
  // is the checked default.
  await openSettingsSection(page, "display");
  await expect(page.getByTestId("time-format-hms")).toBeChecked();

  // Switch to no-seconds — the OPEN scrollback must re-render live (signal-
  // backed formatter), no reload.
  await page.getByTestId("time-format-hm").click();
  await expect(await firstTimeCell(page)).toHaveText(HM_RE);

  // Close the drawer, the row keeps the chosen format. closeSettings uses the
  // header × — #460's "done" footer button lives on the main index only, and
  // we are on the display sub-page.
  await closeSettings(page);
  await expect(await firstTimeCell(page)).toHaveText(HM_RE);

  // Persistence: a full reload restores the stored preference (no-seconds).
  await page.reload();
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect.poll(async () => await scrollbackLines(page).count()).toBeGreaterThan(0);
  await expect(await firstTimeCell(page)).toHaveText(HM_RE);
  // And the drawer reflects the persisted choice.
  await openSettingsSection(page, "display");
  await expect(page.getByTestId("time-format-hm")).toBeChecked();
});
