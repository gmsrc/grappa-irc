// #189 — on-connect perform list settings editor, e2e.
//
// The unit layers cover the server-side expansion + the 001 lifecycle (perform
// runs before the built-in identify + autojoin), the REST endpoint, and the
// api client. This spec drives the VISIBLE outcome end-to-end against the real
// integration stack: open the per-network editor, save a raw command list + an
// oper password, and see the state round-trip against real server state — the
// list text persists, oper_pass_set flips to "set", and the write-only secret
// is never surfaced as a value.
//
// SINGLE subject arm (vjt user): the perform editor is a per-network settings
// surface behaving identically for every subject class (the server stores it on
// the credential via the same shape). No subject-shaped branch to parameterize.

import { openSettingsDrawer, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = "#bofh";

test.setTimeout(90_000);

// Reset the perform list to empty (clears both the list + the oper secret).
// Idempotent pre-clean + finally cleanup.
const clearPerform = (token: string): Promise<unknown> =>
  fetch(`${GRAPPA_BASE_URL}/networks/${NETWORK_SLUG}/perform`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ perform_list: "", oper_pass: "" }),
  }).catch(() => {});

test("#189 — perform editor: nav row, save list + oper pass, round-trips against server", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  try {
    await clearPerform(vjt.token);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // Open via the settings nav row (proves the row exists + wiring).
    await openSettingsDrawer(page);
    await page.getByTestId("perform-settings-entry").click();
    await expect(page.getByTestId("perform-subpage")).toBeVisible({ timeout: 10_000 });

    const list = page.getByTestId(`perform-list-${NETWORK_SLUG}`);
    const operStatus = page.getByTestId(`perform-oper-status-${NETWORK_SLUG}`);

    // Freshly cleared: empty list, oper pass not set.
    await expect(list).toHaveValue("");
    await expect(operStatus).toHaveText(/not set/i);

    // Fill the raw command list + an oper password, then save.
    await list.fill("MODE mynick +x\nWHOIS mynick");
    await page.getByTestId(`perform-oper-${NETWORK_SLUG}`).fill("hunter2");
    await page.getByTestId(`perform-save-${NETWORK_SLUG}`).click();

    // Saved: the server echo flips oper_pass_set → "set" (cic never originates
    // state — the status reflects the authoritative round-trip).
    await expect(operStatus).toHaveText(/: set/i, { timeout: 10_000 });
    await expect(page.getByTestId(`perform-saved-${NETWORK_SLUG}`)).toBeVisible();

    // Re-mount the sub-page (back → re-enter) → the list text persisted
    // server-side and the secret stays "set" but is never surfaced as a value.
    await page.getByTestId("perform-back").click();
    await page.getByTestId("perform-settings-entry").click();
    await expect(page.getByTestId(`perform-list-${NETWORK_SLUG}`)).toHaveValue(
      "MODE mynick +x\nWHOIS mynick",
    );
    await expect(page.getByTestId(`perform-oper-status-${NETWORK_SLUG}`)).toHaveText(/: set/i);
    // The oper-pass input is write-only — never pre-filled with the secret.
    await expect(page.getByTestId(`perform-oper-${NETWORK_SLUG}`)).toHaveValue("");
  } finally {
    await clearPerform(vjt.token);
  }
});
