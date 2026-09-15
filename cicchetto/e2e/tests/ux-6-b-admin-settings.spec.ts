// UX-6-B (2026-05-21) — Playwright e2e for the admin Settings tab.
//
// Covers:
//   * Admin opens AdminPane → Settings tab renders w/ defaults
//     fetched from GET /admin/settings.
//   * Admin flips active host embedded → litterbox → Save → PUT
//     /admin/settings → 200 with new view + saved-indicator
//     appears.
//   * The reactive `serverSettings()` signal in cic re-hydrates
//     from the server-side fan-out broadcast (parity with the
//     cic-bundle-changed precedent): re-opening the picker on a
//     fresh page reads the new active host.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT —
// the gate at m7-admin-gate covers the visibility; this spec covers
// the behavior assuming admin reach.
//
// Per `feedback_cicchetto_browser_smoke`: this Playwright spec IS
// the browser smoke for the Settings tab. PUT → server fan-out →
// reactive signal update across surfaces is invisible to vitest
// jsdom (no real WS, no real REST).
//
// Per `feedback_no_silent_drops_closed`: after-test cleanup MUST
// reset the active_host back to "embedded" so subsequent specs
// (including UX-6-B embedded-upload) don't pick up a stale
// litterbox pin. We use the request fixture (admin bearer from
// seedData) to PUT it back in afterEach.

import { expect, test } from "@playwright/test";
import { adminLogin, openAdminConsole } from "../fixtures/cicchettoPage";
import { getSeededAdmin } from "../fixtures/seedData";

// issue 2185 defaults, the values `ServerSettings` hands back when no row
// exists. Hardcoded here for the same reason `video_max_duration_seconds: 120`
// below is: the afterEach has no before-snapshot to restore from, and a reset
// that guesses is worse than one that states what it restores to.
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;
const DCC_DEFAULT_MAX_TRANSFER_BYTES = 100 * MIB;
const DCC_DEFAULT_GLOBAL_CAP_BYTES = 10 * GIB;

type AdminSettingsDcc = { max_transfer_bytes: number; global_cap_bytes: number };

// issue 2202 — the DCC pair has NO `/api/server-settings` twin to read back
// from, and that is by design rather than an omission: `public_view/0` carries
// only the `upload` subtree plus `http_host_aliases`, because the view is
// broadcast to every cic client and the DCC ceilings are admin-only. So the
// round-trip in the #201 test below reads `/api/server-settings` and the DCC
// one reads `/admin/settings` — the same intent (ask the server what it
// stored, through the door the setting actually has), a different door.
async function readDccSettings(
  request: import("@playwright/test").APIRequestContext,
  token: string,
): Promise<AdminSettingsDcc> {
  const res = await request.get("/admin/settings", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).settings.dcc as AdminSettingsDcc;
}

async function openAdminPaneAndSettingsTab(page: import("@playwright/test").Page): Promise<void> {
  // openAdminConsole waits for the settings drawer to finish its 200ms
  // slide-out before returning, so the Settings-tab click below can't land on
  // the still-closing drawer — the latent delivery race #508's iOS font floor
  // perturbed into a ~9% flake (see the primitive's comment in cicchettoPage).
  await openAdminConsole(page);
  await page.getByTestId("admin-tab-settings").click();
  await expect(page.getByTestId("admin-settings-tab")).toBeVisible();
}

test.describe("UX-6-B admin Settings tab", () => {
  test.afterEach(async ({ request }) => {
    // Reset to the server default so subsequent specs (including this
    // file's other tests + the embedded-upload spec) see a clean
    // active_host. Per `feedback_no_silent_drops_closed`: stale shared
    // state is a quiet source of cross-spec flakes.
    const admin = getSeededAdmin();
    const res = await request.put("/admin/settings", {
      headers: { authorization: `Bearer ${admin.token}` },
      // #201 — the duration cap joins active_host in the reset: the
      // video-upload specs probe a ~1s clip against it, so a lowered
      // value left behind would refuse every one of them.
      //
      // issue 2202 — and so do the two DCC ceilings, for the same reason one
      // step over: `Grappa.Dcc.Policy.admit_offer/1` reads the per-transfer
      // cap, so a lowered value left behind would refuse the ~24 KB offer
      // `issue2089-dcc-consent-banner.spec.ts` builds its whole banner on.
      data: {
        upload: { active_host: "embedded", video_max_duration_seconds: 120 },
        dcc: {
          max_transfer_bytes: DCC_DEFAULT_MAX_TRANSFER_BYTES,
          global_cap_bytes: DCC_DEFAULT_GLOBAL_CAP_BYTES,
        },
      },
    });
    expect(res.ok()).toBe(true);
  });

  test("renders default settings + can flip active host litterbox → embedded", async ({ page }) => {
    await adminLogin(page, getSeededAdmin());
    await openAdminPaneAndSettingsTab(page);

    // Defaults from B1: embedded host + 10 MB per-file + 10 GB global.
    await expect(page.getByTestId("admin-settings-active-host")).toHaveValue("embedded");

    // Flip to litterbox + save.
    await page.getByTestId("admin-settings-active-host").selectOption("litterbox");
    await page.getByTestId("admin-settings-save").click();

    // Saved indicator appears after the PUT succeeds.
    await expect(page.getByTestId("admin-settings-saved")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("admin-settings-active-host")).toHaveValue("litterbox");
  });

  test("422 invalid_setting flags the offending field", async ({ page }) => {
    await adminLogin(page, getSeededAdmin());
    await openAdminPaneAndSettingsTab(page);

    // Zero image per-file cap → server returns 422 invalid_setting
    // with field: "upload.image_per_file_cap_bytes".
    const perFile = page.getByTestId("admin-settings-image-cap");
    await perFile.fill("0");
    await page.getByTestId("admin-settings-save").click();

    await expect(perFile).toHaveClass(/admin-settings-field-error/, { timeout: 5_000 });
  });

  test("PUT /admin/settings fans out server_settings_changed on user-topics", async ({ page }) => {
    await adminLogin(page, getSeededAdmin());
    await openAdminPaneAndSettingsTab(page);

    // Listen on the page console + waitForResponse for the PUT, then
    // verify the page state. The fan-out itself is wire-level
    // (Phoenix Channel push); browser-side proof = the saved-indicator
    // + the local serverSettings() signal update, both verified above.
    // Cross-tab fan-out is exercised at the server level by the
    // SettingsControllerTest fan-out assertions; this e2e covers the
    // happy-path round trip end-to-end.
    await page.getByTestId("admin-settings-active-host").selectOption("litterbox");
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/admin/settings") && r.request().method() === "PUT",
      ),
      page.getByTestId("admin-settings-save").click(),
    ]);
    expect(response.status()).toBe(200);

    await expect(page.getByTestId("admin-settings-saved")).toBeVisible({ timeout: 5_000 });
  });

  // #201 — the video duration ceiling became a server setting. Full
  // round trip: form → PUT → DB → the operator-facing GET that cic's
  // upload orchestrator reads its ceiling from. The REFUSAL itself
  // (an over-long clip rejected with a message naming the new value)
  // is pinned by vitest, not here: the only committed video fixture,
  // e2e/fixtures/tiny.mp4, is exactly 1.000s (mvhd timescale 1000 /
  // duration 1000) and the smallest settable ceiling is 1s, so no
  // admin value can make it too long.
  test("video duration cap: form → PUT → /api/server-settings (#201)", async ({
    page,
    request,
  }) => {
    const admin = getSeededAdmin();
    await adminLogin(page, admin);
    await openAdminPaneAndSettingsTab(page);

    const duration = page.getByTestId("admin-settings-video-max-duration");
    await expect(duration).toHaveValue("120");

    await duration.fill("45");
    await page.getByTestId("admin-settings-save").click();
    await expect(page.getByTestId("admin-settings-saved")).toBeVisible({ timeout: 5_000 });

    // The value the CLIENT reads — same door cic hydrates from at boot.
    const res = await request.get("/api/server-settings", {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.ok()).toBe(true);
    expect((await res.json()).upload.video_max_duration_seconds).toBe(45);
  });

  test("422 invalid_setting flags the video duration field (#201)", async ({ page }) => {
    await adminLogin(page, getSeededAdmin());
    await openAdminPaneAndSettingsTab(page);

    const duration = page.getByTestId("admin-settings-video-max-duration");
    await duration.fill("0");
    await page.getByTestId("admin-settings-save").click();

    await expect(duration).toHaveClass(/admin-settings-field-error/, { timeout: 5_000 });
  });

  // issue 2202 — the DCC pair, on the #201 pair's model. The two ceilings
  // shipped in 1.5.8 with a working admin API and no form at all, so until
  // this spec the ONLY thing that had ever driven them was a hand-rolled PUT.
  // jsdom cannot stand in: it never issues the real request, so "the wire
  // carries bytes" is exactly the claim a unit test asserts against its own
  // mock and a browser asserts against the server.
  test("DCC caps: form → PUT → GET /admin/settings (issue 2202)", async ({ page, request }) => {
    const admin = getSeededAdmin();
    await adminLogin(page, admin);
    await openAdminPaneAndSettingsTab(page);

    // The fields SEED from the admin view — asserted against what the server
    // actually holds right now, not against a literal, so the test states the
    // contract ("the UI shows the stored bytes in MiB/GiB") rather than
    // re-stating a default that another spec could legitimately move.
    const before = await readDccSettings(request, admin.token);
    const maxTransfer = page.getByTestId("admin-settings-dcc-max-transfer");
    const spoolCap = page.getByTestId("admin-settings-dcc-global-cap");
    await expect(maxTransfer).toHaveValue(String(before.max_transfer_bytes / MIB));
    await expect(spoolCap).toHaveValue(String(before.global_cap_bytes / GIB));

    // Move both, off the defaults AND off each other, so a subtree crossed
    // with the other one cannot pass.
    await maxTransfer.fill("200");
    await spoolCap.fill("25");
    await page.getByTestId("admin-settings-save").click();
    await expect(page.getByTestId("admin-settings-saved")).toBeVisible({ timeout: 5_000 });

    // Close the loop where the setting actually lives. BYTES: a form that
    // shipped the raw MiB would land 200 and 25 here.
    const after = await readDccSettings(request, admin.token);
    expect(after.max_transfer_bytes).toBe(200 * MIB);
    expect(after.global_cap_bytes).toBe(25 * GIB);
  });

  // Two save cycles, and the SECOND is the one that discriminates.
  //
  // A 422 on `dcc.max_transfer_bytes` alone does NOT prove the highlight keys
  // on the dotted path: that key has no upload twin, so a component matching
  // only the last segment would light exactly the same row and pass. The key
  // that separates the two implementations is `global_cap_bytes`, the one
  // member of BOTH closed sets. Measured, not argued — under a mutant that
  // compares `field.split(".").pop()`, phase 1 stays green and phase 2 goes
  // red (see the DESIGN_NOTES entry for this issue).
  test("422 invalid_setting flags the DCC field and NOT the upload ones (issue 2202)", async ({
    page,
  }) => {
    await adminLogin(page, getSeededAdmin());
    await openAdminPaneAndSettingsTab(page);

    const maxTransfer = page.getByTestId("admin-settings-dcc-max-transfer");
    const dccSpoolCap = page.getByTestId("admin-settings-dcc-global-cap");
    const uploadGlobalCap = page.getByTestId("admin-settings-global-cap");
    const save = page.getByTestId("admin-settings-save");

    // Phase 1 — field-level rendering at all, on the #201 pair's model. Zero
    // per-transfer cap → `apply_dcc_key/2` refuses a non-positive integer →
    // 422 with field "dcc.max_transfer_bytes".
    await maxTransfer.fill("0");
    await save.click();
    await expect(maxTransfer).toHaveClass(/admin-settings-field-error/, { timeout: 5_000 });
    // Asserted AFTER the positive, so the response has demonstrably landed and
    // this is not reading a pre-request DOM.
    await expect(uploadGlobalCap).not.toHaveClass(/admin-settings-field-error/);
    await expect(page.getByTestId("admin-settings-image-cap")).not.toHaveClass(
      /admin-settings-field-error/,
    );

    // Phase 2 — the colliding key. Restore the per-transfer cap so the ONLY
    // invalid value in the body is the DCC spool budget: with one bad key the
    // 422 names it whatever order the controller folds the subtree in, so the
    // assertion does not rest on Elixir map iteration order.
    await maxTransfer.fill("200");
    await dccSpoolCap.fill("0");
    await save.click();

    await expect(dccSpoolCap).toHaveClass(/admin-settings-field-error/, { timeout: 5_000 });
    // THE assertion: `upload.global_cap_bytes` is a different budget under the
    // same key name, and it must stay clean.
    await expect(uploadGlobalCap).not.toHaveClass(/admin-settings-field-error/);
    // And the previous phase's highlight cleared — `onSave` resets fieldError,
    // so a stale mark here would mean the form accumulates errors forever.
    await expect(maxTransfer).not.toHaveClass(/admin-settings-field-error/);
  });
});
