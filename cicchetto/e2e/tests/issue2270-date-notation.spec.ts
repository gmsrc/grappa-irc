// issue 2270 — user-facing timestamps rendered in US order instead of the
// viewer's, proven on a real browser with the locale PINNED.
//
// ## Why the locale is pinned, and why that is the whole point
//
// vjt, on the issue: "an e2e that asserts a literal `dd/mm/yyyy` string has to
// pin the locale explicitly — asserting against the runner's ambient locale is
// how this class of bug hides." The container's ambient locale is `en-US`
// (measured), so a spec that said nothing would accidentally test the reported
// case and would silently stop testing it the day the image changed. Both
// tests below therefore declare their locale with `test.use`.
//
// ## The surface
//
// `.banlist-modal-time` — the ban "set at" instant, which is the site the bug
// was REPORTED on and one of the five that used to call a bare
// `toLocaleString()`. It is driven end-to-end (a real +b against the live
// upstream, folded from 367/368), so this asserts what a reader sees rather
// than what a renderer returns.
//
// ## Why the assertions are computed, not literal
//
// A live ban is stamped NOW, so the spec cannot know the date in advance, and
// hardcoding one would make this a calendar bomb. Instead `year first` supplies
// an ANCHOR: `yyyy-mm-dd` names the year, month and day unambiguously, and the
// other two notations are then asserted to be those same three components in
// their own order. No date formatting is reimplemented here — the expectations
// are string surgery over the app's own output, which is also why a renderer
// that started lying in ALL notations at once could not slip past: `ymd` is
// cross-checked against the day the ban was actually created.

import type { Page } from "@playwright/test";
import { composeSend, loginAs, openSettingsDrawer, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test.setTimeout(120_000);

const BAN_MASK = "*!*@issue2270.invalid";

/** Pick a date notation through the REAL settings select, then close the drawer. */
async function chooseNotation(page: Page, key: string): Promise<void> {
  await openSettingsDrawer(page);
  await expect(page.getByRole("dialog", { name: /settings/i })).toHaveClass(/open/, {
    timeout: 10_000,
  });
  await page.getByTestId("display-settings-entry").click();
  const select = page.getByTestId("date-format-select");
  await expect(select).toBeVisible({ timeout: 10_000 });
  await select.selectOption(key);
  await page.getByTestId("settings-drawer-close").click();
  await expect(page.getByRole("dialog", { name: /settings/i })).not.toHaveClass(/open/, {
    timeout: 10_000,
  });
}

/** Open /banlist and read the rendered "set at" instant of the single entry. */
async function readBanInstant(page: Page): Promise<string> {
  await composeSend(page, "/banlist");
  const modal = page.getByTestId("banlist-modal");
  await expect(modal).toBeVisible({ timeout: 15_000 });
  const time = modal.locator(".banlist-modal-time").first();
  await expect(time).toBeVisible({ timeout: 15_000 });
  const text = (await time.textContent())?.trim() ?? "";
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden({ timeout: 10_000 });
  return text;
}

/** Create a fresh channel (sole op), add one ban, and leave it in place. */
async function seedBannedChannel(page: Page): Promise<string> {
  const channel = `#t2270-${Date.now()}`;
  await composeSend(page, `/join ${channel}`);
  await expect(
    page.locator(".sidebar-network-section li").filter({ hasText: channel }),
  ).toHaveCount(1, { timeout: 15_000 });
  await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });

  await composeSend(page, "/banlist");
  const modal = page.getByTestId("banlist-modal");
  await expect(modal).toBeVisible({ timeout: 15_000 });
  // Wait for the opening query to SETTLE before mutating: two overlapping
  // /banlist queries race on the 367/368 fold (no request-id on the wire), and
  // the first 368 would drop the added ban from the store. Same hazard #386's
  // spec documents.
  await expect(modal.getByTestId("banlist-add-input")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1_000);

  await modal.getByTestId("banlist-add-input").fill(BAN_MASK);
  await modal.getByTestId("banlist-add-btn").click();
  await expect(modal.locator(".banlist-modal-mask", { hasText: BAN_MASK })).toBeVisible({
    timeout: 15_000,
  });
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden({ timeout: 10_000 });
  return channel;
}

/** `yyyy-mm-dd` → its three components, asserted to actually be that shape. */
function anchorParts(ymd: string): { y: string; m: string; d: string } {
  const match = /(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  expect(match, `the 'year first' notation must render yyyy-mm-dd, got: ${ymd}`).not.toBeNull();
  const [, y, m, d] = match as RegExpExecArray;
  return { y, m, d };
}

// ---------------------------------------------------------------------------
// The reported case: a browser that resolves en-US, on a viewer who wants
// day-first. `auto` cannot rescue them — the web exposes no region — so the
// preference is the only cure, and this is the test that proves it is one.
// ---------------------------------------------------------------------------
test.describe("issue 2270 — an en-US browser", () => {
  test.use({ locale: "en-US" });

  test("renders month-first by default and DAY-first once the viewer picks it", async ({
    page,
  }) => {
    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

    const channel = await seedBannedChannel(page);
    try {
      // The anchor first: `ymd` names the three components with no ambiguity.
      await chooseNotation(page, "ymd");
      const { y, m, d } = anchorParts(await readBanInstant(page));

      // `auto` on an en-US browser is month-first. This is not the bug being
      // asserted as correct — it is the REPORTED symptom, pinned so the cure
      // below is measured against it rather than against an assumption.
      await chooseNotation(page, "auto");
      expect(await readBanInstant(page)).toContain(`${m}/${d}/${y}`);

      // The cure: the same field, same browser, same locale, day-first.
      await chooseNotation(page, "dmy");
      expect(await readBanInstant(page)).toContain(`${d}/${m}/${y}`);

      // And month-first stays reachable as an explicit choice, so the two
      // notations are proven DISTINCT renderings rather than one string that
      // happens to satisfy both regexes on a day when d === m.
      await chooseNotation(page, "mdy");
      expect(await readBanInstant(page)).toContain(`${m}/${d}/${y}`);
    } finally {
      await composeSend(page, `/part ${channel}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The acceptance criterion from the reporter: "a browser set to Italian must
// get gg/mm/aaaa". vjt's note on what that implies — it is satisfied by the
// DEFAULT resolution step, not by the preference — is exactly what this test
// pins: `auto`, untouched, on an it-IT browser.
// ---------------------------------------------------------------------------
test.describe("issue 2270 — an it-IT browser", () => {
  test.use({ locale: "it-IT" });

  test("gets gg/mm/aaaa from the DEFAULT key, with no preference set", async ({ page }) => {
    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

    const channel = await seedBannedChannel(page);
    try {
      // Read the anchor, then return to `auto` — the state a fresh viewer is
      // in. The round trip is what makes this a test of the DEFAULT rather
      // than of `dmy` under another name.
      await chooseNotation(page, "ymd");
      const { y, m, d } = anchorParts(await readBanInstant(page));

      await chooseNotation(page, "auto");
      const shown = await readBanInstant(page);
      expect(shown).toContain(`${d}/${m}/${y}`);
      // Stated as an inequality too: an Italian browser must NOT regress to
      // the US order, which is what a hardcoded `en-US` fallback would do.
      if (d !== m) expect(shown).not.toContain(`${m}/${d}/${y}`);
    } finally {
      await composeSend(page, `/part ${channel}`);
    }
  });
});
