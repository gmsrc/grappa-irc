// issue 2288 — the admin Uploads tab, end to end.
//
// `GET /admin/uploads` + `DELETE /admin/uploads/:id` shipped with UX-6-B1 and
// had NO door in cic: nothing under `cicchetto/src` referenced the route, so
// an operator asked to pull an attachment before its TTL could only reach it
// with curl. This spec drives the door that closes that gap, and it asserts
// the OUTCOME rather than the wiring:
//
//   1. a real upload exists (POST /api/uploads, the real door, real bytes);
//   2. the tab LISTS it — found by the slug, which is the only token shared
//      between the link in a channel and a row in this table;
//   3. the inline-confirm Delete moves it out of the LIVE set — the row stays
//      on screen (the listing is the audit trail) but reads `deleted`, and the
//      button is gone;
//   4. the bytes are really gone: the public `/uploads/<slug>` now 404s. That
//      is the half a DOM-only assertion cannot see, and the whole point of the
//      verb — a tab that greyed the row while the file stayed served would
//      satisfy every assertion above it.
//
// Per `feedback_e2e_user_class_parity_matrix`: the admin console is
// admin-gated EXEMPT. `m7-admin-gate-settings-drawer.spec.ts` covers
// reachability for all three user classes; this spec covers the admin case
// only, because the other two cannot mount AdminPane at all.
//
// Per `feedback_cicchetto_browser_smoke`: this IS the browser smoke for the
// tab — the inline-confirm class flip and the card/table rendering are CSS
// behaviour jsdom does not have.

import { TINY_PNG_HEX } from "../fixtures/bytes";
import { openAdminUploadsTab } from "../fixtures/cicchettoPage";
import { publicUploadStatus } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";
import { uploadPngViaRest } from "../fixtures/uploadJourney";

test("issue 2288 — the admin Uploads tab lists an upload and deletes it out of the live set", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const filename = `issue2288-${Date.now()}.png`;

  // Same login shape as the other admin specs: seed the bearer, then go. Not
  // `loginAs`, which waits for a network section the admin account need not
  // have.
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [admin.token, admin.subjectJson] as const,
  );
  await page.goto("/");

  const uploaded = await uploadPngViaRest(page, TINY_PNG_HEX, filename);

  // Precondition, asserted rather than assumed: the bytes ARE served before
  // the operator acts. Without it a later 404 proves nothing — an upload that
  // never worked would give the same reading.
  expect(await publicUploadStatus(uploaded.url, "GET")).toBe(200);

  const panel = await openAdminUploadsTab(page);

  // Locate by slug: an operator reading a link in a channel has the slug and
  // nothing else, so this is the lookup the tab has to support. The row id is
  // then read back off the DOM for the controls keyed on it — same shape as
  // `adminSessionRowKey`.
  const row = panel.locator("tr.admin-uploads-row").filter({ hasText: uploaded.slug });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).toContainText(filename);
  await expect(row).toContainText("live");

  const testId = await row.getAttribute("data-testid");
  if (testId === null) throw new Error("the upload row lost its data-testid");
  const id = testId.replace("admin-upload-row-", "");

  // Inline-confirm two-step, the same ladder every destructive admin verb
  // uses: the first click only arms.
  const deleteBtn = page.getByTestId(`admin-upload-delete-${id}`);
  await expect(deleteBtn).toHaveText(/^delete$/i);
  await deleteBtn.click();
  await expect(deleteBtn).toHaveText(/^confirm delete$/i);
  await deleteBtn.click();

  // The row SURVIVES — soft-deleted rows are the audit trail — but it has left
  // the live set: it carries its deletion time and offers no second delete.
  await expect(page.getByTestId(`admin-upload-delete-${id}`)).toHaveCount(0, { timeout: 15_000 });
  await expect(row).toContainText(/deleted/i);
  await expect(page.getByTestId("admin-uploads-error")).toHaveCount(0);

  // The file is gone for anyone holding the link. 404 and not 410/200-empty:
  // `GET /uploads/:slug` collapses every failure onto one answer on purpose,
  // so a moderated attachment is indistinguishable from one that never
  // existed.
  expect(await publicUploadStatus(uploaded.url, "GET")).toBe(404);
});
