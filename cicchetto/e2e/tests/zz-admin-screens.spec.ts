// THROWAWAY — visual capture harness for the admin-console redesign.
// NOT a gate. Delete before the PR: it asserts nothing, it only takes
// pictures so the redesign can be judged against the current state.
//
// Run:  scripts/integration.sh --project chromium --grep "admin screens"
// Shots land under cicchetto/e2e/test-results/<test>/ via testInfo.outputPath.

import { test } from "../fixtures/test";
import { expectShellReady, openAdminConsole } from "../fixtures/cicchettoPage";
import { getSeededAdmin } from "../fixtures/seedData";

const TABS = [
  "visitors",
  "sessions",
  "networks",
  "vhosts",
  "users",
  "credentials",
  "events",
  "session_log",
  "settings",
  "debug",
] as const;

// There is NO theme key in localStorage: `applyTheme` (src/lib/theme.ts:44)
// resolves the base theme purely from `prefers-color-scheme` and writes
// `<html data-theme>`. So the harness drives the theme with Playwright's
// `colorScheme`, not with storage — an earlier `grappa-theme` key was a
// no-op and every shot came out mirc-light.
const THEMES = [
  { name: "irssi-dark", colorScheme: "dark" },
  { name: "mirc-light", colorScheme: "light" },
] as const;

const VIEWS = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "mobile", viewport: { width: 393, height: 852 } },
] as const;

// admin-vjt has no network bind, so the usual loginAs shell-ready selector
// (.sidebar-network-section h3) never appears — same reason
// m7-admin-gate-settings-drawer.spec.ts rolls its own login.
async function loginAsAdmin(page: import("@playwright/test").Page): Promise<void> {
  const seed = getSeededAdmin();
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [seed.token, seed.subjectJson] as const,
  );
  await page.goto("/");
  await expectShellReady(page);
}

for (const view of VIEWS) {
  for (const theme of THEMES) {
    test.describe(`admin screens — ${view.name} ${theme.name}`, () => {
      test.use({ viewport: view.viewport, colorScheme: theme.colorScheme });

      test(`admin screens ${view.name} ${theme.name}`, async ({ page }, testInfo) => {
        test.setTimeout(180_000);
        await loginAsAdmin(page);
        await openAdminConsole(page);

        for (const tab of TABS) {
          await page.getByTestId(`admin-tab-${tab}`).click();
          // let the tab's fetch settle; these tabs have no single
          // settled-signal in common, and this spec asserts nothing.
          await page.waitForTimeout(1_200);
          await page.screenshot({
            path: testInfo.outputPath(`${view.name}-${theme.name}-${tab}.png`),
            fullPage: true,
          });
        }
      });
    });
  }
}
