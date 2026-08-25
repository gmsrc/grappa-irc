// #363 — incognito (ephemeral) session, browser-observable halves.
//
// The chain has four links; three are proven cheaply off-browser and the
// two that genuinely need a real browser + real server live here:
//   - checkbox → login request .......... Login.test.tsx (vitest)
//   - request → incognito visitor row ... auth_controller_test.exs
//   - reconcile + linger + reap ......... visitors_test / reaper_test.exs
//   - [HERE] checkbox visibility in a real DOM (nick vs email)
//   - [HERE] incognito session disables share-session (server → /me → gate)
//   - [HERE] #1770: closing the PWA is a /quit — the row is gone at once
//
// Copy is deliberately NOT asserted: the checkbox keys off its data-testid,
// so vjt's final (pending) wording swap can never break this spec.

import {
  bootVisitorContext,
  openSettingsDrawer,
  waitForUserTopicReady,
} from "../fixtures/cicchettoPage";
import { mintVisitor, reapVisitors, visitorExists } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

test("#363 incognito checkbox: shown under Advanced for a nick, hidden for an email", async ({
  page,
}) => {
  // Fresh context (no bearer) → RequireAuth lands on the login form.
  await page.addInitScript(() => localStorage.setItem("cic.installChoice", "browser"));
  await page.goto("/login");

  const identifier = page.getByLabel(/nick or email/i);

  // Nick identifier → the incognito toggle is available once Advanced opens.
  await identifier.fill("ghost");
  await page.getByRole("button", { name: /advanced/i }).click();
  await expect(page.getByTestId("login-incognito")).toBeVisible();

  // Switch to an email → an account login is never ephemeral, so the toggle
  // disappears (Advanced stays open; only the incognito row is conditional).
  await identifier.fill("someone@example.com");
  await expect(page.getByTestId("login-incognito")).toHaveCount(0);
});

test("#363 incognito session disables share-session; a normal visitor keeps it", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  // Two REAL logins (distinct nicks → no 433): one incognito, one ordinary.
  const ghost = await mintVisitor(`inc-${stamp}`, true);
  const normal = await mintVisitor(`norm-${stamp}`, false);

  // The server actually provisioned the ghost as incognito (login-response
  // subject carries the flag).
  expect(ghost.subject.incognito).toBe(true);
  expect(normal.subject.incognito ?? false).toBe(false);

  const bootIntoSettings = async (v: typeof ghost) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(
      ([token, subjectJson]) => {
        localStorage.setItem("grappa-token", token);
        localStorage.setItem("grappa-subject", subjectJson);
        localStorage.setItem("cic.installChoice", "browser");
      },
      [v.token, JSON.stringify(v.subject)] as const,
    );
    await page.goto("/");
    await openSettingsDrawer(page);
    await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
    return { ctx, page };
  };

  const incog = await bootIntoSettings(ghost);
  const plain = await bootIntoSettings(normal);
  try {
    // Incognito session → share-session entry is GONE (not portable).
    await expect(incog.page.getByTestId("share-session-entry")).toHaveCount(0);
    // Ordinary visitor → share-session entry present (the control).
    await expect(plain.page.getByTestId("share-session-entry")).toBeVisible();
  } finally {
    await incog.ctx.close();
    await plain.ctx.close();
    // Reap BOTH visitors — the variadic collects so a failed first delete
    // can't skip the second (see reapVisitors).
    await reapVisitors(admin.token, ghost.id, normal.id);
  }
});

// #1770 (item 2 of #363) — the fast path the wiring never got. Before it,
// `client_closing` only marked the socket hidden and the row lived on until the
// 1h linger stopped being renewed.
//
// 🔴 The close gesture is `page.close({ runBeforeUnload: true })`, and that is a
// MEASUREMENT, not a preference. On a standalone chromium + webkit bench,
// `context.close()` delivers NO pagehide report at all (chromium sends only the
// WebSocket close frame; webkit sends nothing), and `window.close()` likewise —
// Playwright skips unload handlers unless asked, which a real tab close does
// not. With `runBeforeUnload` the report lands over the socket at +4 ms
// (chromium) / +2 ms (webkit), in both engines. A spec written around
// `ctx.close()` would fail here for a harness reason and send the reader
// hunting a product bug that is not there.
//
// The wait is the real grace, not a guess: `config/dev.exs` sets
// `:incognito_close_grace_ms` to 2s for this stack (production is 30s — see
// `Grappa.Visitors.Reaper`), so the poll ceiling below is grace + margin and
// still well inside Playwright's 30s per-test default.
test("#1770 closing an incognito PWA is a /quit: the row is gone, no linger wait", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const ghost = await mintVisitor(`quit-${Date.now()}`, true);
  expect(ghost.subject.incognito).toBe(true);

  const { ctx, page } = await bootVisitorContext(browser, ghost);
  try {
    // The report rides the USER channel, so no joined channel means no report:
    // gate on the subscribe rather than on paint.
    await waitForUserTopicReady(page, `visitor:${ghost.id}`);

    // Pre-state, asserted rather than assumed — without it a wipe that never
    // happened and a row that never existed read identically.
    expect(await visitorExists(admin.token, ghost.id)).toBe(true);

    await page.close({ runBeforeUnload: true });

    await expect.poll(() => visitorExists(admin.token, ghost.id), { timeout: 15_000 }).toBe(false);
  } finally {
    await ctx.close();
    // Idempotent: `adminDeleteVisitor` counts 404 as success, so this is a
    // no-op on the green path and a real cleanup on every red one.
    await reapVisitors(admin.token, ghost.id);
  }
});
