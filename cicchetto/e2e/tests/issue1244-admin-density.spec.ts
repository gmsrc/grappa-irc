// #1244 — what the admin console spends VERTICALLY on a phone, after
// #1223 bought its horizontal budget by stacking every label above its
// value.
//
// vjt, retesting `e0ef575c` on a 440px iPhone: *"every fact now stacks
// its label above its value, so a three-fact card is six rows where three
// would do"* — `VISITORS` / `0/∞`, `USERS` / `1/3`, `PER-IP` / `5`, two
// full rows each to print four characters, and the same again for `LAST
// SEEN` / `CHANNELS` / `ACTIONS` on the session card below.
//
// The layout that answers it has TWO branches, and both are asserted here
// because a fix that only did one of them would be the previous round
// again in the other direction:
//
//   short — the label and its value share one line, label at the card's
//     left edge, value flush with its right one. This is the row that was
//     costing two.
//   long — a value whose content does not fit beside its label moves to
//     the next line, where it is alone and starts at the card's left edge
//     with the full width to wrap into. This is #1223's stacked layout,
//     kept for the values that need it.
//
// 🔴 These two branches are the successor to two #1223 asserts, by vjt's
// ruling on this issue (2026-08-12): *"'the four asserts from #1223 stay
// green' was shorthand for do not regress the horizontal budget, not keep
// those literal thresholds"*. `a card value starts at the card's edge`
// (`indent <= 2` on every labelled cell) and `a detail fact gives its
// value the panel's full width` (`dd` under `dt`, `dd >= 0.85 * table`)
// both encode the stacked layout as the ONLY correct answer, which is
// what the issue reverses. They become the LONG branch below, and the
// short branch gets the new claim. The two tests they came from carry a
// pointer to here rather than a weakened threshold, so nobody has to
// reconstruct which of the two rounds is current.
//
// What does NOT move: nothing in the console may overflow the viewport
// horizontally (`ux-6-g-admin-mobile-h-scroll`, with the single named
// `.adm-nav` exemption vjt restored on the same retest), no panel value
// may be broken mid-token, and the detail panel still fills its cell.
// Those are the horizontal budget, and this issue is not allowed to
// spend it.
//
// Measured at 393px AND 440px. 393 is the width every other admin guard
// runs at and the one the h-scroll oracle is calibrated to; 440 is the
// device vjt actually reported from, and the two are far enough apart
// that a value can fit beside its label at one and not at the other. A
// fix proven at one width is not proven at his.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated, the EXEMPT
// shape — non-admin cannot reach this surface at all.

import type { Locator, Page } from "@playwright/test";
import { adminLogin, adminSessionRowKey, openAdminConsole } from "../fixtures/cicchettoPage";
import { mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// admin-vjt has no network bind, so `loginAs`'s network-section
// shell-ready selector would time out. Same shape as #1223 / #1073.
async function openSessionsTab(page: Page): Promise<void> {
  await openAdminConsole(page);
  await page.getByTestId("admin-tab-sessions").click();
  await expect(page.getByTestId("admin-sessions-table")).toBeVisible({ timeout: 10_000 });
}

// One labelled field of a record card, as the three numbers that decide
// which branch it is in and whether that branch is correct.
//
// The value is read through a `Range` over the cell's CONTENTS, which
// excludes the `::before` label by construction — a pseudo-element is not
// in the DOM and cannot be ranged. So these measure the painted value
// against the cell's own content box, with no way to accidentally
// measure the label instead.
type CardField = {
  label: string;
  // Distance from the value's first line to the top of the cell's
  // content box. 0 means the value shares the label's line; a label line
  // above it puts this at ~15px.
  fromTop: number;
  // Distance from the cell's left content edge to where the value
  // starts, and from where it ends to the right one.
  indent: number;
  rightGap: number;
};

async function readCardFields(row: Locator): Promise<CardField[]> {
  return row.evaluate((tr) => {
    const out: CardField[] = [];
    for (const td of tr.querySelectorAll("td[data-label]")) {
      // Painted only: the secondary columns are `display: none` on a
      // phone and have no boxes, which is a different guard's business.
      if (td.getClientRects().length === 0) continue;
      // `.adm-cell-title` is the card's HEADING, deliberately label-less
      // — there is no pair to put on one line.
      if (td.classList.contains("adm-cell-title")) continue;

      const range = document.createRange();
      range.selectNodeContents(td);
      const content = range.getBoundingClientRect();
      if (content.width === 0) continue;

      const box = td.getBoundingClientRect();
      const style = window.getComputedStyle(td);
      const padTop = Number.parseFloat(style.paddingTop);
      const padLeft = Number.parseFloat(style.paddingLeft);
      const padRight = Number.parseFloat(style.paddingRight);

      out.push({
        label: td.getAttribute("data-label") ?? "",
        fromTop: Math.round(content.top - (box.top + padTop)),
        indent: Math.round(content.left - (box.left + padLeft)),
        rightGap: Math.round(box.right - padRight - content.right),
      });
    }
    return out;
  });
}

// The same reading for the detail panel, where both halves of the pair
// are real elements and can be measured directly.
type PanelFact = {
  label: string;
  sameLine: boolean;
  valueRightGap: number;
  boxWidth: number;
};

async function readPanelFacts(panel: Locator): Promise<PanelFact[]> {
  return panel.locator(".adm-fact").evaluateAll((pairs) =>
    pairs.map((pair) => {
      const dt = pair.querySelector("dt");
      const dd = pair.querySelector("dd");
      if (dt === null || dd === null) throw new Error("a fact pair lost its dt or its dd");
      const dtBox = dt.getBoundingClientRect();
      const ddBox = dd.getBoundingClientRect();
      // The glyphs, measured against the PAIR's right edge — not against
      // `dd`'s own box, which was this oracle's first form and proved
      // nothing. A `dd` sized to its content holds its text flush against
      // its own right edge wherever that box happens to sit, so the
      // reading came out 0 for a value parked in the middle of the row.
      // A mutation run is what said so: stopping `dd` from growing left
      // this assertion green and was caught two assertions later, by
      // accident, at one width out of two.
      const range = document.createRange();
      range.selectNodeContents(dd);
      const text = range.getBoundingClientRect();
      return {
        label: (dt.textContent ?? "").trim(),
        // Vertical overlap, not a top comparison: `align-items: baseline`
        // gives the two boxes different tops on the same line, and a
        // stacked pair shares no vertical extent at all.
        sameLine: ddBox.top < dtBox.bottom - 0.5,
        valueRightGap: Math.round(pair.getBoundingClientRect().right - text.right),
        boxWidth: ddBox.width,
      };
    }),
  );
}

for (const width of [393, 440]) {
  test.describe(`#1244 admin density at ${width}px`, () => {
    // 393 is what every other admin guard measures; 440 is vjt's device.
    // The height is the same at both so a difference in the readings can
    // only come from the width under test.
    test.use({ viewport: { width, height: 956 } });

    test(`#1244 @webkit at ${width}px a card field is one row while its value is short`, async ({
      page,
    }) => {
      const admin = getSeededAdmin();
      const visitor = await mintVisitor(`dens1244-${Date.now()}`);

      try {
        await adminLogin(page, getSeededAdmin());
        await openSessionsTab(page);

        const key = await adminSessionRowKey(page, "visitor", visitor.id);
        const row = page.getByTestId(`admin-session-row-${key}`);
        await row.scrollIntoViewIfNeeded();
        await expect(row).toBeVisible();

        const fields = await readCardFields(row);

        // Non-vacuity first, and separately, so a card that stopped
        // painting labelled cells reads as that rather than as a density
        // regression: every assertion below filters this list, and an
        // empty list would fail them with the wrong sentence.
        expect(fields.length, "the card must have labelled fields to measure").toBeGreaterThan(0);

        // Non-vacuity, and the claim of this issue in one assertion: at
        // least one field prints its label and its value on the SAME
        // line. Under #1223's `flex: 0 0 100%` every field stacks and
        // this is the assertion that goes red — which is the point, that
        // layout is what #1244 reverses.
        expect(
          fields.filter((f) => f.fromTop <= 2).map((f) => f.label),
          `no card field puts its value on its label's line — ${JSON.stringify(fields)}`,
        ).not.toEqual([]);

        // The short branch: a value beside its label is flush with the
        // card's right edge. Without that it sits wherever the label
        // happens to end, which is the ragged, half-empty row the fixed
        // 5rem track used to produce.
        expect(
          fields.filter((f) => f.fromTop <= 2 && f.rightGap > 2),
          `a value on its label's line must end at the card's right edge — ${JSON.stringify(fields)}`,
        ).toEqual([]);

        // A value beside its label must have the label BEFORE it. A zero
        // indent on the label's line would mean the label is not being
        // painted at all, which would satisfy the assertion above for
        // the wrong reason.
        expect(
          fields.filter((f) => f.fromTop <= 2 && f.indent <= 2),
          `a value on its label's line must start past the label — ${JSON.stringify(fields)}`,
        ).toEqual([]);

        // The long branch, and the surviving half of #1223's `a card
        // value starts at the card's edge`: a value that took its own
        // line gets the whole of it. Not required to OCCUR — the values
        // on a session card are all short at both widths, which is vjt's
        // whole complaint — so this is a rule over whatever lands there
        // rather than a claim that something does. The branch is
        // exercised for real in the panel test below, where `last event`
        // is long at both widths and a stacked fact is REQUIRED.
        expect(
          fields.filter((f) => f.fromTop > 2 && f.indent > 2),
          `a value on its own line must start at the card's edge — ${JSON.stringify(fields)}`,
        ).toEqual([]);
      } finally {
        await reapVisitors(admin.token, visitor.id);
      }
    });

    test(`#1244 @webkit at ${width}px a panel fact is one row while its value is short`, async ({
      page,
    }) => {
      const admin = getSeededAdmin();
      const visitor = await mintVisitor(`densp1244-${Date.now()}`);

      try {
        await adminLogin(page, getSeededAdmin());
        await openSessionsTab(page);

        const key = await adminSessionRowKey(page, "visitor", visitor.id);
        await page.getByTestId(`admin-session-details-${key}`).tap();
        const panel = page.getByTestId(`admin-session-detail-${key}`);
        await expect(panel).toBeVisible({ timeout: 5_000 });

        const facts = await readPanelFacts(panel);
        const inline = facts.filter((f) => f.sameLine);
        const stacked = facts.filter((f) => !f.sameLine);

        // BOTH branches must occur here, and this panel is the one place
        // in the console where both reliably do: `connection` prints
        // `connected`, `last event` prints an event name and an ISO
        // instant. A panel showing only one kind would let half the
        // layout go unmeasured.
        expect(
          inline.map((f) => f.label),
          `no panel fact puts its value on its label's line — ${JSON.stringify(facts)}`,
        ).not.toEqual([]);
        expect(
          stacked.map((f) => f.label),
          `no panel fact is long enough to stack — nothing exercises the long branch: ${JSON.stringify(facts)}`,
        ).not.toEqual([]);

        // Short branch: right-aligned, so the values line up down the
        // panel's right edge instead of each starting wherever its own
        // label ended.
        expect(
          inline.filter((f) => f.valueRightGap > 2),
          `a value on its label's line must end at the panel's right edge — ${JSON.stringify(inline)}`,
        ).toEqual([]);

        // Long branch, and the surviving half of #1223's `a detail fact
        // gives its value the panel's full width`: the reference box is
        // still the TABLE, not the facts list. That correction is the
        // whole point of the assertion it comes from — the list is
        // INSIDE the panel, so a ratio against it shrinks numerator and
        // denominator together and cannot see a squeezed panel.
        const tableBox = await page.getByTestId("admin-sessions-table").boundingBox();
        expect(tableBox, "the sessions table must have a box to measure against").not.toBeNull();
        const tableWidth = tableBox?.width ?? 0;
        expect(tableWidth, "the table must have a width to fill").toBeGreaterThan(200);

        expect(
          stacked.filter((f) => f.boxWidth < tableWidth * 0.85).map((f) => f.label),
          `a value on its own line must take the table's width, not the shrunken panel's — ` +
            `${JSON.stringify(stacked.map((f) => ({ label: f.label, box: Math.round(f.boxWidth) })))} ` +
            `of table ${Math.round(tableWidth)}px`,
        ).toEqual([]);
      } finally {
        await reapVisitors(admin.token, visitor.id);
      }
    });
  });
}

// Item 2 of the issue, which is about the boxes rather than about what is
// in them: *"three nested containers (tab panel → section card →
// per-network card) each contribute their own border and padding,
// stacking ~3 frames around a value that is five characters long"*.
//
// The oracle counts FRAMES rather than pixels, because that is the thing
// vjt described and a pixel budget would have to be re-argued the day a
// border changes width. A frame is any box between the record card and
// the pane that insets its own contents — border or padding, either
// counts, since both put a gap where the value could be.
//
// Run at 440px only: the count is a property of the box tree, not of the
// width, and 440 is the screen it was reported from.
test.describe("#1244 the nesting around a record card", () => {
  test.use({ viewport: { width: 440, height: 956 } });

  test("#1244 @webkit a record card sits inside one frame, not three", async ({ page }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`frame1244-${Date.now()}`);

    try {
      await adminLogin(page, getSeededAdmin());
      await openSessionsTab(page);

      const key = await adminSessionRowKey(page, "visitor", visitor.id);
      const row = page.getByTestId(`admin-session-row-${key}`);
      await row.scrollIntoViewIfNeeded();
      await expect(row).toBeVisible();

      const frames = await row.evaluate((tr) => {
        const pane = tr.closest("[data-testid='admin-pane']");
        if (pane === null) throw new Error("the row is not inside the admin pane");
        const out: { name: string; inset: number }[] = [];
        for (let n: Element | null = tr; n !== null && n !== pane; n = n.parentElement) {
          const style = window.getComputedStyle(n);
          const inset =
            Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth);
          if (inset <= 0) continue;
          const name = n.getAttribute("data-testid") ?? String(n.className || n.tagName);
          out.push({ name: String(name).slice(0, 40), inset: Math.round(inset) });
        }
        return out;
      });

      // The pane's own `1rem` gutter is NOT in this walk and is not up
      // for discussion: it is the console's edge, shared by every
      // surface it holds, cards or not. What the issue is about is the
      // frames INSIDE it, and the record card is the one that earns its
      // place — it is the only line saying where one record stops and
      // the next starts.
      expect(
        frames,
        `only the record card may frame a value between it and the pane — chain: ${JSON.stringify(frames)}`,
      ).toHaveLength(1);

      // Non-vacuity: the walk must have found real boxes. A selector
      // drift that made `frames` empty would satisfy a `<= 1` check
      // while measuring nothing, which is the failure mode the whole
      // #1223 round was about.
      expect(
        frames[0]?.inset ?? 0,
        "the record card must be the frame that remains",
      ).toBeGreaterThan(0);
    } finally {
      await reapVisitors(admin.token, visitor.id);
    }
  });
});
