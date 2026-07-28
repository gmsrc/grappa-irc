// #363 — incognito (ephemeral) session, browser-observable halves.
//
// The chain has four links; three are proven cheaply off-browser and the
// two that genuinely need a real browser + real server live here:
//   - checkbox → login request .......... Login.test.tsx (vitest)
//   - request → incognito visitor row ... auth_controller_test.exs
//   - reconcile + linger + reap ......... visitors_test / reaper_test.exs
//   - [HERE] checkbox visibility in a real DOM (nick vs email)
//   - [HERE] incognito session disables share-session (server → /me → gate)
//
// Copy is deliberately NOT asserted: the checkbox keys off its data-testid,
// so vjt's final (pending) wording swap can never break this spec.

import { adminDeleteVisitor, mintVisitor } from "../fixtures/grappaApi";
import { openSettingsDrawer } from "../fixtures/cicchettoPage";
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
    await adminDeleteVisitor(admin.token, ghost.id).catch(() => {});
    await adminDeleteVisitor(admin.token, normal.id).catch(() => {});
  }
});
