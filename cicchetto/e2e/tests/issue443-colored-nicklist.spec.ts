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
  computedColor,
  inlineNickColorVar,
  loginAs,
  openSettingsSection,
  resolveCssColor,
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

  // The monochrome baseline, captured BEFORE the toggle: whatever `--fg`
  // resolves to in the live cascade. The coloured state below has to be
  // different from THIS, and an unresolvable palette var lands exactly here.
  const monochrome = await computedColor(ownNickText(page));

  // Open Settings → display sub-page (#460); the toggle lives in the display
  // options section and is unchecked by default (current behavior).
  await openSettingsSection(page, "display");
  await expect(page.getByTestId("colored-nicklist-toggle")).not.toBeChecked();

  // Flip it ON — the OPEN members pane must re-render LIVE (signal-backed, no
  // reload): the nick-text gains an inline `color: var(--nick-color-N)`.
  await page.getByTestId("colored-nicklist-toggle").check();
  await expect(ownNickText(page)).toHaveAttribute("style", /color/);
  // ...and the var() resolves to a real hue in the live cascade (jsdom can't
  // do this — the browser proof). Two assertions, one mutant each:
  //
  //   (1) the hue actually moved OFF the inherited `--fg`. An undeclared or
  //       unresolvable `--nick-color-N` is invalid-at-computed-value-time and
  //       the span silently inherits `--fg` — still a colour, so the retired
  //       `/^rgba?\(/` oracle accepted that as a pass. This one does not.
  //   (2) the hue is the one the span DECLARES, not one a stray rule with
  //       higher specificity (or a theme `!important`) painted over it.
  //
  // Both compare opaque computed strings — see `resolveCssColor` for why a
  // parsed rgb tuple is the wrong oracle here.
  const coloured = await computedColor(ownNickText(page));
  expect(coloured).not.toBe(monochrome);
  const declaredSlot = await resolveCssColor(page, await inlineNickColorVar(ownNickText(page)));
  expect(coloured).toBe(declaredSlot);

  // Close the drawer; the applied color sticks. closeSettings uses the header
  // × — #460's "done" footer button lives on the main index only, and we are
  // on the display sub-page.
  await closeSettings(page);
  await expect(ownNickText(page)).toHaveAttribute("style", /color/);

  // Persistence: a full reload restores the stored preference (colored ON).
  await page.reload();
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(ownNickText(page)).toHaveAttribute("style", /color/);
  // ...and the SAME hue: nick → slot is a pure hash, so a fresh document
  // must land on the colour the previous one did. A mapping that drifted
  // per page-load (a seeded/randomised hash) would restore the preference
  // and still repaint the roster on every reload.
  expect(await computedColor(ownNickText(page))).toBe(coloured);

  // And the drawer reflects the persisted choice.
  await openSettingsSection(page, "display");
  await expect(page.getByTestId("colored-nicklist-toggle")).toBeChecked();
});
