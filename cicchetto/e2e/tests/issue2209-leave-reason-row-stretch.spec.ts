// issue 2209 — the two leave-reason rows render centred with shrink-to-fit
// inputs, because `.leave-reason-row` (0,1,0) loses `align-items` to
// `.settings-drawer label` (0,1,1).
//
// WHY THIS SPEC EXISTS AND THE UNIT TESTS DO NOT SUFFICE, stated as a
// measurement rather than a claim: `SettingsDrawer.test.tsx` ALREADY asserted
// `align-items: stretch` on this rule, and it was GREEN for the two months the
// defect shipped. It could not have been anything else — jsdom loads no
// stylesheet, so that assertion reads the DECLARATION off the source text and
// says nothing about which rule wins. Declaring a property and applying it are
// different facts, and only an engine that runs the cascade can tell them
// apart. This spec is the only artefact in the repo that can go red on a
// specificity loss.
//
// THE MUTANT IS THE DEFECT ITSELF. Reverting the cure's selector back to the
// bare `.leave-reason-row` reproduces #2209 exactly, and it breaks BOTH rows
// at once — which is the point of a single shared rule. A spec that watched
// only one row could not tell "one rule for both" from "two twin patches", so
// both rows are asserted, by the same loop, from the same expectations.
//
// ENGINE COVERAGE, declared. Chromium only, deliberately: the broken fact is
// selector specificity, which is arithmetic defined by CSS Cascade Level 5 and
// carries no engine-specific behaviour — unlike #962's flex `min-height: auto`
// interaction, whose iPhone provenance earned it a @webkit leg. A second
// engine here would re-measure the same arithmetic at twice the cost. If a
// WebKit-only divergence in `align-items: stretch` on a column flex is ever
// observed, that is a new fact and earns its own leg.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: subject-shape-
// agnostic CSS layout contract — registered vjt suffices.

import { loginAs, openSettingsDrawer } from "../fixtures/cicchettoPage";
import { expect, specUser, test } from "../fixtures/test";

// Both rows, by the testid of the input each one wraps. The list is the spec's
// statement that the cure is ONE rule: every entry goes through the identical
// assertions below, and a fix that singled out an instance would leave the
// other entry red.
const ROW_INPUTS = ["auto-away-reason-input", "quit-part-reason-input"] as const;

type RowGeometry = {
  alignItems: string;
  flexDirection: string;
  rowGap: number;
  expectedGap: number;
  contentWidth: number;
  contentLeft: number;
  inputWidth: number;
  labelLeft: number | null;
  intrinsicInputWidth: number;
};

test("2209 — both leave-reason rows stretch their controls to the rail", async ({ page }) => {
  const vjt = specUser();

  await loginAs(page, vjt);
  await openSettingsDrawer(page);
  await page.getByTestId("general-settings-entry").click();

  for (const testId of ROW_INPUTS) {
    const input = page.getByTestId(testId);
    await expect(input).toBeVisible({ timeout: 5_000 });

    const geometry: RowGeometry = await input.evaluate((el) => {
      const row = el.closest(".leave-reason-row");
      if (row === null) throw new Error("no .leave-reason-row ancestor");

      const rowStyle = getComputedStyle(row);
      const rowBox = row.getBoundingClientRect();
      // The row's CONTENT box, which is what a stretched child fills. The
      // padding comes from `.settings-drawer label`, so it is real and
      // subtracting it is not cosmetic.
      const padLeft = Number.parseFloat(rowStyle.paddingLeft);
      const padRight = Number.parseFloat(rowStyle.paddingRight);

      const label = row.querySelector(".leave-reason-label");

      // ANTI-HOLLOW-GREEN PROBE. "The input fills the row" is vacuously true
      // whenever the rail happens to be as narrow as a text field's intrinsic
      // width, and it would then pass on the broken build too. Measure that
      // width in the real engine instead of guessing at a pixel constant: an
      // identical control with `align-self: flex-start` opts OUT of the
      // container's `align-items`, so it is shrink-to-fit whichever way the
      // cascade resolved. Appended last and removed immediately, after every
      // real measurement above it has been taken.
      const probe = document.createElement("input");
      probe.type = "text";
      probe.style.alignSelf = "flex-start";
      row.appendChild(probe);
      const intrinsicInputWidth = probe.getBoundingClientRect().width;
      probe.remove();

      return {
        alignItems: rowStyle.alignItems,
        flexDirection: rowStyle.flexDirection,
        rowGap: Number.parseFloat(rowStyle.rowGap),
        // 0.35rem resolved by the page rather than hardcoded, so a root
        // font-size change moves the expectation with it.
        expectedGap: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.35,
        contentWidth: rowBox.width - padLeft - padRight,
        contentLeft: rowBox.left + padLeft,
        inputWidth: el.getBoundingClientRect().width,
        labelLeft: label === null ? null : label.getBoundingClientRect().left,
        intrinsicInputWidth,
      };
    });

    // The probe's verdict first: without spare cross-axis room nothing below
    // discriminates, and a hollow green is worse than a red.
    expect(
      geometry.intrinsicInputWidth,
      `${testId}: the rail is too narrow for stretch to be observable`,
    ).toBeLessThan(geometry.contentWidth - 1);

    // The cascade fact, read straight off the engine. This is the assertion
    // the source-level test could not make.
    expect(geometry.alignItems, `${testId}: align-items`).toBe("stretch");

    // The half that already worked, kept as a negative control: `column` never
    // lost, because nothing contends it. A cure that somehow won `align-items`
    // by dropping the column would satisfy the line above and fail here.
    expect(geometry.flexDirection, `${testId}: flex-direction`).toBe("column");

    // The second silent casualty of the same specificity loss: the row asks
    // for 0.35rem and was taking the base rule's 0.5rem.
    expect(geometry.rowGap, `${testId}: row-gap`).toBeCloseTo(geometry.expectedGap, 1);

    // ...and what the human actually reported: a full-width field.
    expect(geometry.inputWidth, `${testId}: input width`).toBeCloseTo(geometry.contentWidth, 0);

    // ...and a left-aligned label, on the row that has one. `reason:` is far
    // narrower than the rail, so under `align-items: center` its left edge sits
    // well inside the content box; under `stretch` it is flush with it.
    if (geometry.labelLeft !== null) {
      expect(geometry.labelLeft, `${testId}: label left edge`).toBeCloseTo(geometry.contentLeft, 0);
    }
  }
});
