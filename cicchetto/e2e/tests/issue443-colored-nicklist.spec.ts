// #443 — the members pane renders nicks monochrome by default (the color
// channel there encodes the mode TIER, not identity, so MembersPane passes
// `noColor` to NickText). "show colored nicklist" in Settings → display
// options opts into the per-nick hash hue. Switching it re-renders the OPEN
// nicklist LIVE (colorNicklist is a Solid signal, not a boot-time DOM write —
// the whole reason it mirrors timeFormat.ts rather than fontSize.ts), and the
// choice persists across a reload (localStorage).
//
// jsdom is CSS-cascade-blind (per `feedback_cicchetto_browser_smoke`): the
// live `var(--nick-color-N)` application only exists in a real browser, so the
// unit tests pin the noColor WIRING while this e2e pins the CSS-driven color
// actually landing on the DOM node — the design's central live-toggle claim.
// Sibling precedent: issue217-timestamp-format.spec.ts (Settings toggle →
// live re-render → persist).
//
// Desktop project (untagged → chromium). Own nick (specNick()) is always in
// the roster, so there is a stable `.members-pane .member-name .nick-text` to
// assert on regardless of the autojoin op-race.

import {
  closeSettings,
  loginAs,
  openSettingsSection,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(60_000);

// The own-nick row's nick-text span in the desktop members pane. Re-query
// each call so assertions see the current DOM after a live re-render / reload.
function ownNickText(page: import("@playwright/test").Page) {
  return page
    .locator(".members-pane .member-name")
    .filter({ hasText: specNick() })
    .first()
    .locator(".nick-text")
    .first();
}

test("#443 — colored nicklist off by default, toggles live from Settings, persists", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  await expect(ownNickText(page)).toBeVisible({ timeout: 10_000 });

  // Default (no stored preference) → monochrome: MembersPane passes noColor,
  // so NickText omits the inline per-nick color and the row inherits --fg.
  // No inline `color` in the style attribute.
  await expect(ownNickText(page)).not.toHaveAttribute("style", /color/);

  // Open Settings → display sub-page (#460); the toggle lives in the display
  // options section and is unchecked by default (current behavior).
  await openSettingsSection(page, "display");
  await expect(page.getByTestId("colored-nicklist-toggle")).not.toBeChecked();

  // Flip it ON — the OPEN members pane must re-render LIVE (signal-backed, no
  // reload): the nick-text gains an inline `color: var(--nick-color-N)`.
  await page.getByTestId("colored-nicklist-toggle").check();
  await expect(ownNickText(page)).toHaveAttribute("style", /color/);
  // ...and the var() resolves to a real hue in the live cascade (jsdom can't
  // do this — the browser proof).
  const computed = await ownNickText(page).evaluate((el) => getComputedStyle(el).color);
  expect(computed).toMatch(/^rgba?\(/);

  // Close the drawer; the applied color sticks. closeSettings uses the header
  // × — #460's "done" footer button lives on the main index only, and we are
  // on the display sub-page.
  await closeSettings(page);
  await expect(ownNickText(page)).toHaveAttribute("style", /color/);

  // Persistence: a full reload restores the stored preference (colored ON).
  await page.reload();
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(ownNickText(page)).toHaveAttribute("style", /color/);

  // And the drawer reflects the persisted choice.
  await openSettingsSection(page, "display");
  await expect(page.getByTestId("colored-nicklist-toggle")).toBeChecked();
});
