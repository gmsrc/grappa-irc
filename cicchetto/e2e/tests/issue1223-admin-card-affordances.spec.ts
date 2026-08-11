// #1223 items 2 and 3 — what an admin row card does on a phone, once
// #1157 turned rows into cards.
//
// vjt, dogfooding staging on an iPhone: *"abbiamo tap target solo sul testo
// quando invece dovrebbe esser tutta l'area, parlo ad es dei nomi visitor"*.
// Two separate defects behind that reading, both of them layout, both
// therefore invisible to jsdom (`feedback_cicchetto_browser_smoke`) and to
// every vitest suite that mounts these components:
//
//   2. `.adm-row-expand` puts the 44px `--tap-min` floor on HEIGHT only and
//      sizes its box with `inline-flex`, so the door to the row's detail is
//      the caret + badge + nick run and the rest of the card's heading is
//      dead space that looks tappable. Asserted by TAPPING that dead space
//      and requiring the panel to open — the visible outcome, not the
//      declarations that produce it.
//
//   3. `.adm-facts` sizes its label track from the LONGEST label, so on a
//      393px screen the value track keeps well under half the width and
//      wraps timestamps over several lines. Asserted as the value track
//      taking the panel's full width, with the label above it.
//
// Item 1 of the same issue (the detail panel repeating fields the card
// already shows) is NOT in scope here: it needs a product call between
// dropping the columns for real and dropping the panel on mobile, and it is
// the only one of the three that changes what is on screen rather than where
// it is.
//
// The desktop test is the counter-claim, and it is why item 3's fix is a
// `@container` rule rather than a blanket single column: at a width where two
// columns fit, two columns are what the operator gets. Without it, collapsing
// unconditionally would pass.
//
// Sessions is the tab under test because its disclosure is `alwaysOpenable`
// (#1157), so the SAME control can be measured at both widths. The button is
// `AdminRowName`, which every tab routes identity through.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated, the EXEMPT shape.

import type { Locator, Page } from "@playwright/test";
import { adminSessionRowKey, expectShellReady, openAdminConsole } from "../fixtures/cicchettoPage";
import { mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// admin-vjt has no network bind, so `loginAs`'s network-section shell-ready
// selector would time out. Same shape as #1073 / m7-admin-gate / m11-events.
async function adminLogin(page: Page): Promise<void> {
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

async function openSessionsTab(page: Page): Promise<void> {
  await openAdminConsole(page);
  await page.getByTestId("admin-tab-sessions").click();
  await expect(page.getByTestId("admin-sessions-table")).toBeVisible({ timeout: 10_000 });
}

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator, what: string): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null)
    throw new Error(`${what} has no layout box — the markup or the classes drifted`);
  return box;
}

test("#1223 @webkit on a phone the whole card heading opens the row, not just the nick", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const visitor = await mintVisitor(`tap1223-${Date.now()}`);

  try {
    await adminLogin(page);
    await openSessionsTab(page);

    const key = await adminSessionRowKey(page, "visitor", visitor.id);
    const row = page.getByTestId(`admin-session-row-${key}`);
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();

    // Pre-state, asserted rather than assumed: the panel is CLOSED, so the
    // tap below is what opens it and not a coincidence of a panel already on
    // screen from a previous step.
    const panel = page.getByTestId(`admin-session-detail-${key}`);
    await expect(panel).toHaveCount(0);

    const heading = row.locator("td.adm-cell-title");
    const glyphs = row.locator(".admin-session-lines");
    const headingBox = await boxOf(heading, "the card heading cell");
    const glyphBox = await boxOf(glyphs, "the identity's glyph run");

    // The probe point: the heading's right end, past everything that is
    // drawn. If the glyph run happens to fill the heading there is no dead
    // space to aim at and the tap would prove nothing — fail loudly rather
    // than pass vacuously.
    const tapX = headingBox.x + headingBox.width - 6;
    const tapY = headingBox.y + headingBox.height / 2;
    const deadSpace = tapX - (glyphBox.x + glyphBox.width);
    expect(
      deadSpace,
      "the probe must land beyond the drawn identity — otherwise it is not testing the dead space",
    ).toBeGreaterThan(8);

    await page.touchscreen.tap(tapX, tapY);

    await expect(
      panel,
      "tapping the card heading beside the nick must open the row's detail",
    ).toBeVisible({ timeout: 5_000 });
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});

test("#1223 @webkit on a phone a detail fact gives its value the panel's full width", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const visitor = await mintVisitor(`facts1223-${Date.now()}`);

  try {
    await adminLogin(page);
    await openSessionsTab(page);

    const key = await adminSessionRowKey(page, "visitor", visitor.id);
    await page.getByTestId(`admin-session-details-${key}`).tap();
    const panel = page.getByTestId(`admin-session-detail-${key}`);
    await expect(panel).toBeVisible({ timeout: 5_000 });

    const facts = panel.locator(".adm-facts");
    const factsBox = await boxOf(facts, "the facts list");
    const dtBox = await boxOf(facts.locator("dt").first(), "the first fact's label");
    const ddBox = await boxOf(facts.locator("dd").first(), "the first fact's value");

    // The label is a caption ABOVE its value, not a track beside it.
    expect(
      ddBox.y,
      `the value must sit under its label on a narrow panel (facts list ${Math.round(factsBox.width)}px wide)`,
    ).toBeGreaterThanOrEqual(dtBox.y + dtBox.height - 0.5);

    // And the point of moving it: the value gets the width the label track
    // and its gap were taking. Separate from the assertion above because a
    // collapse that left a fixed label column would satisfy that one.
    expect(
      ddBox.width,
      "the value track must take essentially the whole panel width",
    ).toBeGreaterThanOrEqual(factsBox.width * 0.9);
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});

test("#1223 on a wide panel the facts stay two columns", async ({ page }) => {
  const admin = getSeededAdmin();
  const visitor = await mintVisitor(`wide1223-${Date.now()}`);

  try {
    await adminLogin(page);
    await openSessionsTab(page);

    const key = await adminSessionRowKey(page, "visitor", visitor.id);
    await page.getByTestId(`admin-session-details-${key}`).click();
    const panel = page.getByTestId(`admin-session-detail-${key}`);
    await expect(panel).toBeVisible({ timeout: 5_000 });

    const facts = panel.locator(".adm-facts");
    const dtBox = await boxOf(facts.locator("dt").first(), "the first fact's label");
    const ddBox = await boxOf(facts.locator("dd").first(), "the first fact's value");

    // Beside, not under: the phone fix is a container query, so a panel with
    // room keeps the label column that makes a list of facts scannable.
    expect(
      ddBox.x,
      "with room for two columns the value must sit beside its label",
    ).toBeGreaterThanOrEqual(dtBox.x + dtBox.width);
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});
