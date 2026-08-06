// issue687-crt-boot-stages — the CRT splash must say WHICH boot stage it
// is waiting on. Before #687 it showed the same five static lines during
// a healthy 200 ms boot and during a stall, three of them asserting
// subsystems were "OK" while the boot sat on a fetch. The user could not
// tell "still loading" from "dead"; a self-hoster's installed PWA hung on
// that screen every first launch.
//
// WHAT THIS PINS, and why it is not satisfiable by a component that
// merely exists: every assertion reads the RENDERED TEXT of a stage line
// and pairs it with the resource state that produced it. Two directions,
// because only both together are a real proof —
//
//   * a register hard-coded to "done" passes an "is it visible?" check
//     and fails `assertPending` here;
//   * a register hard-coded to pending passes `assertPending` and fails
//     `assertDone` in the second test.
//
// FROZEN BOOT, not a natural one: the splash is the Shell main-pane
// `<Switch fallback>`, alive only until the boot resources settle. We
// hold a stage open with a never-resolving `page.route`, the technique
// crt-splash-font.spec.ts (#180) already uses. PENDING, not aborted: an
// aborted resource ERRORS and Solid re-throws it on read, which trips
// BootErrorBoundary and replaces the splash.
//
// BUDGET: #717's `bootFetch` bounds each boot GET at 8 s and retries
// twice (500 ms + 2 s backoff), so a hung route yields ~26.5 s of splash
// before the boundary takes over. Every assertion below must land inside
// the FIRST attempt's 8 s — hence the explicit short timeouts. If a
// future change to BOOT_FETCH_TIMEOUT_MS shortens that, this spec goes
// red rather than silently asserting against the failure screen.

import { type Locator, type Page, expect, test } from "@playwright/test";

const ME_USER = {
  kind: "user",
  id: "e2e-687",
  name: "e2e-687",
  is_admin: false,
  inserted_at: "2026-01-01T00:00:00Z",
};

function stage(page: Page, id: string): Locator {
  return page.locator(`[data-stage="${id}"]`);
}

async function assertPending(line: Locator, label: string): Promise<void> {
  await expect(line).toBeVisible({ timeout: 7_000 });
  await expect(line).toHaveText(`${label}...`);
  await expect(line).toHaveAttribute("data-done", "false");
}

async function assertDone(line: Locator, label: string): Promise<void> {
  await expect(line).toBeVisible({ timeout: 7_000 });
  await expect(line).toHaveText(`${label}... done`);
  await expect(line).toHaveAttribute("data-done", "true");
}

// Seed a bearer + subject so RequireAuth mounts Shell without a real
// login (auth.ts `isAuthenticated` gates on token PRESENCE), suppress the
// install splash, and stub the boot theme GET so a fake bearer never
// makes a real round-trip. Mirrors crt-splash-font.spec.ts.
async function seedFrozenBoot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("grappa-token", "e2e-687-boot-stages");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "e2e-687", name: "e2e-687" }),
    );
    localStorage.setItem("cic.installChoice", "browser");
  });

  await page.route("**/me/theme", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "null" }),
  );
}

test("a stalled /me names the stage it is stuck on, and claims no others (#687)", async ({
  page,
}) => {
  await seedFrozenBoot(page);
  await page.route("**/me", () => new Promise(() => {}));

  await page.goto("/");

  await expect(page.getByTestId("crt-splash")).toBeVisible({ timeout: 7_000 });

  // The stall is at the first stage, so all three lines must read as
  // unfinished. A splash that printed "done" on a fetch that never
  // answered would be the old lie in a new font.
  await assertPending(stage(page, "me"), "fetching my info");
  await assertPending(stage(page, "networks"), "fetching networks");
  await assertPending(stage(page, "channels"), "fetching channels");
});

test("a stalled /networks shows my info DONE and the stall one line down (#687)", async ({
  page,
}) => {
  await seedFrozenBoot(page);

  // /me answers; the networks fetch it unblocks never does. `**/networks`
  // does not match `/networks/<slug>/channels`, which is a different
  // path — but that fetch is keyed on this one and so never fires.
  await page.route("**/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ME_USER),
    }),
  );
  await page.route("**/networks", () => new Promise(() => {}));

  await page.goto("/");

  await expect(page.getByTestId("crt-splash")).toBeVisible({ timeout: 7_000 });

  // THE differential: the same screen, one stage further on. This is the
  // assertion a static register cannot satisfy at the same time as the
  // first test's.
  await assertDone(stage(page, "me"), "fetching my info");
  await assertPending(stage(page, "networks"), "fetching networks");
  await assertPending(stage(page, "channels"), "fetching channels");
});
