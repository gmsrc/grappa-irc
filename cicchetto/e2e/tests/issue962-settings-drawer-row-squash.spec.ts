// #962 — settings index rows collapse to the 44px tap-target floor and their
// text spills through the row borders.
//
// `.settings-drawer` is a FIXED-height (`var(--viewport-height, 100dvh)`)
// column flex container with `overflow-y: auto`, and the #460 index rows are
// `<button>` DIRECT flex children of it. `:where(.settings-drawer) button`
// (cd626369, #735) sets an EXPLICIT `min-height: var(--tap-min)`, and an
// explicit min-height REPLACES `min-height: auto` — so the rows lose their
// automatic minimum size and the flex algorithm shrinks them to the 44px HIG
// floor whenever the drawer overflows (XXL text, short viewport, keyboard).
// The content needs 68-87px, `align-items: center` centres it in the 44px box,
// and visible overflow spills the label above the top border and the second
// subtitle line below the bottom one. That is the iPhone screenshot on the
// issue, measured on device as `box 44 serve 87` on every row.
//
// This is NOT a WebKit peculiarity: Chrome applies the same rule and collapses
// the rows identically, which is why this spec runs on BOTH projects — the
// untagged test on chromium (short desktop viewport) and the `@webkit` one on
// the iPhone 15 device profile. Both were RED before `flex-shrink: 0` on
// `.settings-drawer > *` (the webkit leg reported `rowHeight 44 / textHeight
// 64` on all seven rows).
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: subject-shape-
// agnostic CSS layout contract — registered vjt suffices.

import type { Page } from "@playwright/test";
import { loginAs, openSettingsDrawer } from "../fixtures/cicchettoPage";
import { expect, specUser, test } from "../fixtures/test";

// Seed the XXL font-size preference on the production localStorage key so
// `applyFontSizeFromStorage()` writes `--font-size` before the first paint,
// exactly as it does on device. Same key ios-z-cluster drives.
async function seedXxlFontSize(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("cicchetto.fontSize", "XXL");
  });
}

async function assertRowsKeepTheirContentHeight(page: Page): Promise<void> {
  const drawer = page.locator(".settings-drawer.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });

  // PRECONDITION (anti-hollow-green): the index must actually overflow the
  // drawer box, otherwise the flex algorithm has no free space to reclaim and
  // every assertion below passes on the broken build too.
  const overflow = await drawer.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);

  // The two halves of the defect, per row: the box collapsed to the --tap-min
  // floor, and the label/subtitle stack (`.settings-nav-row-text`, whose
  // cross-axis height is its content height and so does NOT shrink with the
  // row) spilling past the row's borders. `--tap-min` is read from the live
  // cascade rather than hardcoded, so a future floor change moves with it.
  const broken = await page.locator(".settings-nav-row").evaluateAll((rows) => {
    const tapMin = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--tap-min"),
    );
    return rows.flatMap((row) => {
      const text = row.querySelector(".settings-nav-row-text");
      if (text === null) return [];
      const rowBox = row.getBoundingClientRect();
      const textBox = text.getBoundingClientRect();
      const spill = Math.max(rowBox.top - textBox.top, textBox.bottom - rowBox.bottom);
      const collapsed = rowBox.height <= tapMin + 0.5;
      return spill > 0.5 || collapsed
        ? [
            {
              label: text.querySelector(".settings-nav-row-label")?.textContent ?? "?",
              rowHeight: Math.round(rowBox.height),
              textHeight: Math.round(textBox.height),
              tapMin,
            },
          ]
        : [];
    });
  });
  expect(broken).toEqual([]);

  // The overflow lands on the drawer's own scroll instead: `done`, the last
  // child, is reachable by scrolling to the bottom.
  await drawer.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByTestId("settings-drawer-done")).toBeInViewport();
}

test("#962 — settings nav rows keep their content height when the drawer overflows (desktop)", async ({
  page,
}) => {
  await seedXxlFontSize(page);
  // Short desktop viewport: wide enough to stay on the desktop branch (the
  // 768px mobile breakpoint) while the drawer is too short for the XXL index.
  await page.setViewportSize({ width: 1024, height: 600 });

  const vjt = specUser();
  await loginAs(page, vjt);
  await openSettingsDrawer(page);

  await assertRowsKeepTheirContentHeight(page);
});

test("@webkit @touch #962 — settings nav rows keep their content height when the drawer overflows (iPhone)", async ({
  page,
}) => {
  await seedXxlFontSize(page);

  const vjt = specUser();
  await loginAs(page, vjt);
  await openSettingsDrawer(page);

  await assertRowsKeepTheirContentHeight(page);
});
