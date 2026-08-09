// #460 — settings drawer main page → INDEX of sub-sections, e2e.
//
// The unit layer (SettingsDrawer.test.tsx) pins the index IA + the
// navigate-then-assert into each sub-page in jsdom. This spec drives the
// VISIBLE outcomes end-to-end against the real integration stack + the real
// CSS render (per `feedback_cicchetto_browser_smoke`, which jsdom can't see):
//
//   1. the settings main page renders as an INDEX of nav rows, each carrying
//      a muted subtitle that actually renders (not clipped);
//   2. tapping a NEW sub-page row (general / display / push) replaces the
//      index in place with the moved-VERBATIM content, and the ‹ back button
//      returns to the index;
//   3. the deep-link machinery is untouched by the restructure — a bare
//      /notify still lands the drawer directly on the watch-lists sub-page,
//      NOT the index.
//
// SINGLE subject arm (vjt user), justified per
// `feedback_e2e_user_class_parity_matrix`: the index nav mechanic is
// subject-AGNOSTIC — the same rows / sub-pages / back for every class; only
// WHICH rows show varies (the visitor-only identity card inside general is
// covered by the vitest unit). There is no subject-shaped branch to
// parameterize here.

import { composeSend, loginAs, openSettingsDrawer, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(90_000);

async function openSettings(page: import("@playwright/test").Page): Promise<void> {
  await openSettingsDrawer(page);
  await expect(page.getByRole("dialog", { name: /settings/i })).toHaveClass(/open/, {
    timeout: 10_000,
  });
}

test("#460 — settings main page renders as an index of nav rows, each with a visible subtitle", async ({
  page,
}) => {
  await loginAs(page, getSeededVjt());
  await openSettings(page);

  // The always-present index rows render with their muted subtitle. Real CSS
  // render: the subtitle span must be VISIBLE (a clipped/zero-height subtitle
  // would fail here where jsdom's textContent check can't), and non-empty.
  for (const id of [
    "general-settings-entry",
    "display-settings-entry",
    "themes-settings-entry",
    "push-settings-entry",
    "watchlists-settings-entry",
    "aliases-settings-entry",
    "perform-settings-entry",
  ]) {
    const row = page.getByTestId(id);
    await expect(row).toBeVisible();
    const subtitle = row.locator(".settings-nav-row-subtitle");
    await expect(subtitle).toBeVisible();
    await expect(subtitle).not.toBeEmpty();
  }
});

test("#460 — the display row opens the display sub-page in place; back returns to the index", async ({
  page,
}) => {
  await loginAs(page, getSeededVjt());
  await openSettings(page);

  await page.getByTestId("display-settings-entry").click();
  const subpage = page.getByTestId("display-subpage");
  await expect(subpage).toBeVisible();
  // The #443 display controls moved here VERBATIM.
  await expect(page.getByTestId("colored-nicklist-toggle")).toBeVisible();
  await expect(page.getByTestId("time-format-hms")).toBeVisible();
  // The index is REPLACED in place — a stable index row is gone from the DOM.
  await expect(page.getByTestId("themes-settings-entry")).toHaveCount(0);

  // ‹ back returns to the index.
  await page.getByTestId("display-back").click();
  await expect(subpage).toHaveCount(0);
  await expect(page.getByTestId("themes-settings-entry")).toBeVisible();
});

test("#460 — the notifications row opens the push sub-page; the general row opens upload retention", async ({
  page,
}) => {
  await loginAs(page, getSeededVjt());
  await openSettings(page);

  // push sub-page carries the notifications surface (moved VERBATIM).
  await page.getByTestId("push-settings-entry").click();
  await expect(page.getByTestId("push-subpage")).toBeVisible();
  await expect(page.getByTestId("push-master-toggle")).toBeVisible();
  await page.getByTestId("push-back").click();
  await expect(page.getByTestId("push-subpage")).toHaveCount(0);
  await expect(page.getByTestId("push-settings-entry")).toBeVisible();

  // general sub-page carries upload retention (the seeded host exposes
  // ttlOptions, so the fieldset renders).
  await page.getByTestId("general-settings-entry").click();
  await expect(page.getByTestId("general-subpage")).toBeVisible();
  await expect(page.getByTestId("upload-ttl-select")).toBeVisible();
  await page.getByTestId("general-back").click();
  await expect(page.getByTestId("general-subpage")).toHaveCount(0);
  await expect(page.getByTestId("general-settings-entry")).toBeVisible();
});

test("#460 — deep-link survives the restructure: bare /notify lands on the watch-lists sub-page, not the index", async ({
  page,
}) => {
  await loginAs(page, getSeededVjt());
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  // The requestOpenSettings deep-link path is untouched by #460; it must still
  // open the drawer DIRECTLY on a sub-page, bypassing the index.
  await composeSend(page, "/notify");
  await expect(page.getByTestId("watchlists-subpage")).toBeVisible({ timeout: 10_000 });
  // We deep-linked PAST the index — its rows are not shown.
  await expect(page.getByTestId("themes-settings-entry")).toHaveCount(0);
});
