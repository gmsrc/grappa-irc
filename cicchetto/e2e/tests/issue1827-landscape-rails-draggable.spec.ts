// issue 1827 — in the #319 short-landscape tier the rail drag handles stayed
// mounted, kept painting a `col-resize` cursor and kept accepting the drag,
// but the column never moved: that tier pinned `grid-template-columns` to a
// literal `8rem 1fr 7rem` and did not reference the `--sidebar-width` /
// `--members-width` custom properties the handle writes. The affordance
// promised an action the layout had already opted out of.
//
// Ruling: a visible rail must be resizable, in every tier, with the shell's
// height no longer a condition. So the tier consumes the vars now, and the
// leak it used to prevent by ignoring them — a rail widened on a tall window
// flooding the centre on a short one — is stopped at the clamp instead:
// lib/sidebarWidths.ts gives this tier its own floor (COMPACT_MIN_WIDTH_PX)
// and its own ceiling (a QUARTER of the viewport, not a half), evaluated on
// every read and write, so a stored width clamps DOWN on the way in.
//
// This is the pair #319 could not assert and this issue exists for: the
// never-dragged default is unchanged (that is issue319-landscape-compact-
// shell.spec.ts, deliberately untouched) AND the handle now moves something.
//
// jsdom renders no layout and cascades no `@media`, so the unit tests can
// only reach the JS half — whether the *column* moves is a real-browser
// question and this spec is the only place it is asked. RED pre-fix on the
// width-changed assertion: the grid ignored the var, so the drag left the
// sidebar at its literal 8rem.
//
// Runs on the desktop chromium project; the viewport is overridden to the
// same 844x390 5" landscape shape #319 uses, so both specs describe the same
// tier.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: a UI-shape
// contract, subject-shape-agnostic. Registered seed suffices.

import type { Page } from "@playwright/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Same shape as issue319-landscape-compact-shell.spec.ts: wide enough for the
// desktop shell (> 768px), short enough for the tier (<= 500px).
const TIER = { width: 844, height: 390 };

test.use({ viewport: TIER });
test.setTimeout(60_000);

// The tier's ceiling, mirrored from lib/sidebarWidths.ts: a quarter of the
// viewport, so both rails at their cap still leave the centre at least half.
const TIER_CAP_PX = Math.floor(TIER.width / 4);

async function asideWidth(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no bounding box`);
  return Math.round(box.width);
}

async function dragHandleBy(page: Page, selector: string, dx: number): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no bounding box`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

async function openChannel(page: Page): Promise<void> {
  const vjt = specUser();
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();
}

test("issue 1827 landscape — the drag handle actually moves the rail in the short tier", async ({
  page,
}) => {
  await openChannel(page);

  // Cold, never dragged: the tier's own slim default still renders. This is
  // #319's contract and it must survive untouched — the var is absent until
  // the first drag, so the `8rem` fallback is what the grid resolves.
  const widthBefore = await asideWidth(page, ".shell-sidebar");
  expect(
    widthBefore,
    `issue 1827 — never-dragged left rail ${widthBefore}px must still be #319-slim (< 176px)`,
  ).toBeLessThan(176);

  const handle = page.locator(".shell-sidebar .resize-handle-left");
  await expect(handle).toHaveCount(1);
  await expect(handle).toHaveAttribute("role", "separator");

  // THE assertion the issue is about. RED pre-fix: the tier's
  // `grid-template-columns: 8rem 1fr 7rem` ignored the var the drag writes,
  // so this width came back unchanged and the operator saw nothing move.
  await dragHandleBy(page, ".shell-sidebar .resize-handle-left", 60);
  const widthAfter = await asideWidth(page, ".shell-sidebar");
  expect(
    widthAfter,
    `issue 1827 — rail must MOVE on drag in the short-landscape tier (was ${widthBefore}px, still ${widthAfter}px)`,
  ).toBeGreaterThan(widthBefore + 40);

  // And it is a real drag, not a jump to some fixed width.
  expect(Math.abs(widthAfter - (widthBefore + 60))).toBeLessThanOrEqual(5);
});

test("issue 1827 landscape — the tier's own ceiling keeps the centre the bulk", async ({
  page,
}) => {
  await openChannel(page);

  // Drag well past anything the tier should allow. The desktop bound would
  // permit half the viewport (422px); this tier's is a quarter.
  await dragHandleBy(page, ".shell-sidebar .resize-handle-left", 600);

  const sidebar = await asideWidth(page, ".shell-sidebar");
  expect(
    sidebar,
    `issue 1827 — left rail ${sidebar}px must clamp to the tier ceiling ${TIER_CAP_PX}px, not the desktop half`,
  ).toBeLessThanOrEqual(TIER_CAP_PX + 5);

  const centre = await asideWidth(page, ".shell-main");
  expect(
    centre,
    `issue 1827 — centre ${centre}px must keep at least half of ${TIER.width}px even at the rail's cap`,
  ).toBeGreaterThanOrEqual(TIER.width / 2 - 5);
});

test("issue 1827 landscape — a width stored on a tall window clamps DOWN on the way in", async ({
  page,
}) => {
  // This is the leak the tier used to prevent by refusing to read the vars at
  // all, and the reason the ruling could keep the affordance without giving
  // the centre away: 400px is a legitimate desktop rail and a catastrophic
  // one on an 844px-wide short window.
  await page.addInitScript(() => {
    localStorage.setItem("cicchetto.sidebarWidth", "400");
  });
  await openChannel(page);

  const sidebar = await asideWidth(page, ".shell-sidebar");
  expect(
    sidebar,
    `issue 1827 — stored 400px must clamp to the tier ceiling ${TIER_CAP_PX}px on entry, got ${sidebar}px`,
  ).toBeLessThanOrEqual(TIER_CAP_PX + 5);

  // Non-destructive: the read clamps what it returns, it does not rewrite
  // storage, so leaving the tier restores the operator's desktop width.
  const stored = await page.evaluate(() => localStorage.getItem("cicchetto.sidebarWidth"));
  expect(stored, "issue 1827 — clamping a read must not overwrite the stored desktop width").toBe(
    "400",
  );
});
