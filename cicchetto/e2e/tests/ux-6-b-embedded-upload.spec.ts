// UX-6-B (2026-05-21) — Playwright e2e for the embedded image uploader
// + admin Settings tab.
//
// B1 server stack landed: schema (uploads + server_settings), Uploads
// context + Reaper, ServerSettings context + accessors, POST
// /api/uploads + GET /uploads/:slug + GET /api/server-settings +
// /admin/settings + /admin/uploads, plus nginx allowlist.
// B2 client wiring lands `embeddedHost` + reactive `serverSettings()`
// + `AdminSettingsTab`.
//
// This spec covers the full vertical:
//   * Operator picks a file → ComposeBox → orchestrator → POST
//     /api/uploads (real same-origin, NO mocking) → server writes
//     bytes to disk + inserts row → JSON `{slug, url, expires_at}`
//   * Cic auto-sends `📸 <url>` PRIVMSG → server echoes → linkify
//   * GET /uploads/<slug> serves the bytes back (verified via raw
//     fetch with the same context.cookies — the slug IS the access
//     token, no auth gate).
//
// Per `feedback_ux_e2e_mandatory`: every cic UX-behavior change MUST
// ship with a Playwright e2e; vitest jsdom can't follow the full
// multipart-upload → IRC-echo → linkify chain.
//
// Per `feedback_e2e_user_class_parity_matrix`: the upload feature is
// available to BOTH user + visitor subjects. This spec covers the
// user class via the seeded vjt; the visitor class is covered by
// the existing I-2 spec (litterbox path) — embedded-host parity
// for visitors lands in a follow-up if needed (the server gate is
// `:authn` not user-only, so the path works for visitors at the
// server layer already).
//
// Per `feedback_recurring_e2e_not_flake`: NO upstream-host mocking —
// the embedded path posts to grappa itself, which is deterministic
// in the e2e harness (sqlite + local disk + Reaper).

import { TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
import { EMBEDDED_MODAL_HEADING, pickFile, uploadViaPicker } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("UX-6-B — picker → privacy modal (embedded) → upload → 📸 link → GET serves bytes", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // Picker → privacy modal (embedded host is the server-side default,
  // heading per embeddedHost.displayName) → Continue → POST 201 —
  // the shared journey in fixtures/uploadJourney.ts.
  const respBody = await uploadViaPicker(
    page,
    {
      name: "ux-6-b-embedded.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_HEX, "hex"),
    },
    { postTimeout: 10_000 },
  );

  // The 📸-prefixed PRIVMSG lands in scrollback after the IRC echo.
  // Match a privmsg row containing "📸" + the actual slug.
  const row = scrollbackLine(page, "privmsg", "📸").filter({ hasText: respBody.slug });
  await expect(row.first()).toBeVisible({ timeout: 15_000 });

  // Extract the URL from the row text — the slug carries the bytes-
  // access token, so we can GET it directly to verify the round trip.
  const text = await row.first().textContent();
  if (!text) throw new Error("expected scrollback row text");
  // #418: the URL carries a type extension (`/uploads/<slug>.<ext>`) — the
  // anchor href is the full extensioned URL, so capture the extension too.
  const match = text.match(/(https?:\/\/[^\s]+\/uploads\/[a-z2-7]{26}(?:\.[a-z0-9]+)?)/);
  if (!match) throw new Error(`expected uploads URL in row text: ${text}`);
  const url = match[1];

  // GET /uploads/<slug> — public, no auth. Returns the PNG bytes.
  // Use the page's same-origin context so the URL resolves through
  // the e2e nginx (matches the privacy-modal hostname).
  const res = await page.request.get(`/uploads/${respBody.slug}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/image\/png/i);
  const body = await res.body();
  // PNG magic bytes — 89 50 4E 47 (\x89PNG).
  expect(body[0]).toBe(0x89);
  expect(body[1]).toBe(0x50);
  expect(body[2]).toBe(0x4e);
  expect(body[3]).toBe(0x47);

  // Linkify (CP31 B4) wraps the URL — assert the anchor is present.
  const link = row.first().locator(".scrollback-link").first();
  await expect(link).toHaveAttribute("href", url);
});

test("UX-6-B — privacy modal Cancel does NOT trigger upload (folded from i2 2026-05-26)", async ({
  page,
}) => {
  // Counter pattern — embedded path is same-origin, so a page.route()
  // stub would block cic bootstrap too. Count requests instead.
  let uploadHits = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/uploads")) {
      uploadHits += 1;
    }
  });

  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const modal = await pickFile(
    page,
    {
      name: "ux-6-b-cancel.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_HEX, "hex"),
    },
    EMBEDDED_MODAL_HEADING,
  );
  await modal.locator("button", { hasText: /cancel/i }).click();
  await expect(modal).toBeHidden({ timeout: 5_000 });

  // Give the orchestrator a moment to (not) fire the POST.
  await page.waitForTimeout(500);
  expect(uploadHits).toBe(0);

  // Positive control (#1117 / #1336). The zero above is only evidence if
  // this counter can count: a mistyped path, a `.endsWith` that stopped
  // matching after a route change, or a listener attached to the wrong
  // page all leave `uploadHits` at 0 with the guard broken, and the test
  // is green in both worlds. Drive the SAME journey to Continue instead
  // of Cancel — the real POST goes through the very predicate asserted
  // empty, so a blind counter reds here.
  //
  // Deliberately AFTER the zero: a control placed first would leave a
  // non-zero baseline the assertion above would have to subtract, and an
  // off-by-one in that subtraction is exactly the silence being cured.
  await uploadViaPicker(
    page,
    {
      name: "ux-6-b-cancel-control.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_HEX, "hex"),
    },
    { postTimeout: 10_000 },
  );
  await expect.poll(() => uploadHits, { timeout: 5_000 }).toBeGreaterThan(0);
});
