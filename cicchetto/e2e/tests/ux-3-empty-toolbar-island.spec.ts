// UX-3 BIS (2026-05-17) — `.shell.shell-mobile` safe-area-inset.
//
// Original UX-3 fix put `padding: max(0.5rem, env(safe-area-inset-top))`
// on `.topic-bar` + `.shell-empty-toolbar`. That cleared the bar's
// CONTENT below the Dynamic Island but left the bar's BACKGROUND
// painting under the island (the bar's outer box still started at
// y=0). iOS Safari reserves the status-bar area for OS gestures, so
// touches under the island were captured by the OS, not the page —
// the bar appeared visually clear-ish but was non-interactive.
//
// UX-3 BIS moves the inset from the individual bars to the
// `.shell.shell-mobile` container itself, so the entire mobile shell
// sits inside the safe area. Bar outer boxes start below the island.
// Touch model correct. `box-sizing: border-box` (global) means the
// inset is consumed FROM the shell's 100vh, not added to it.
//
// UX-4 bucket L (2026-05-19, commit 17aefeb) DROPPED
// `.shell-empty-toolbar` from the JSX and swept the CSS orphan in
// lockstep — the always-visible ShellChrome bar replaced the empty-
// toolbar fallbacks. The pre-L `.shell-empty-toolbar` assertion arms
// were removed from this spec (the rule no longer exists; asserting
// "the rule does NOT contain env()" against a deleted rule would
// always pass-vacuously but reads as a regression signal).
//
// Verification strategy. Walk document.styleSheets, find the
// `.shell-mobile` rule (lives under the `@media (max-width: 768px)`
// branch — CSSMediaRule), assert it declares
// `padding-top: env(safe-area-inset-top)`. Webkit-iphone-15
// emulation matches viewport but doesn't inject real env() values —
// computed paddingTop resolves to 0px regardless — so this is a
// SOURCE-shape assertion, not a metric assertion.
//
// #1127 (2026-08-09) flipped the BOTTOM edge: the home-indicator inset
// lifted the shell off the bottom and exposed the transparent area behind
// it (a black band under the tab strip), so `.shell-mobile` now declares
// `padding-bottom: 0` and the shell reaches the physical bottom. The edge
// is still asserted here, with the opposite expectation — and the
// declaration must still be PRESENT, since base `.shell` would otherwise
// cascade the inset back in at equal specificity.
//
// Also assert `.topic-bar` rule NO LONGER contains `env(` /
// `safe-area-inset-top` (the previous fix is reverted at the bar
// level — the container handles it now). That pins the BIS fix shape
// so a future operator can't accidentally re-add the bar-level inset
// (which would double-clear the island and produce visually-empty
// space below it).
//
// Per `feedback_e2e_user_class_parity_matrix`: UX-3 BIS is a CSS
// shape bucket, single visitor login sufficient. Parity matrix
// runs in UX-Z.

import { loginAs } from "../fixtures/cicchettoPage";
import { expect, specUser, test } from "../fixtures/test";

type SelectorPadding = {
  selector: string;
  padding: string;
  paddingTop: string;
  paddingBottom: string;
};

async function findRulePadding(
  page: import("@playwright/test").Page,
  selector: string,
): Promise<SelectorPadding | null> {
  return await page.evaluate((sel) => {
    function visitRules(rules: CSSRuleList): SelectorPadding | null {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSMediaRule) {
          const inner = visitRules(rule.cssRules);
          if (inner) return inner;
          continue;
        }
        if (!(rule instanceof CSSStyleRule)) continue;
        const selectors = rule.selectorText.split(",").map((s) => s.trim());
        if (!selectors.includes(sel)) continue;
        return {
          selector: sel,
          padding: rule.style.getPropertyValue("padding").trim(),
          paddingTop: rule.style.getPropertyValue("padding-top").trim(),
          paddingBottom: rule.style.getPropertyValue("padding-bottom").trim(),
        };
      }
      return null;
    }
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      const found = visitRules(rules);
      if (found) return found;
    }
    return null;
  }, selector);
}

test("@webkit @touch UX-3 BIS — .shell.shell-mobile carries safe-area inset; bars do NOT", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // .shell-mobile rule lives inside @media (max-width: 768px) — must
  // recurse through CSSMediaRule.cssRules to find it. The rule MUST
  // declare the top inset, and MUST declare a flush bottom edge (#1127).
  const shell = await findRulePadding(page, ".shell-mobile");
  expect(shell).not.toBeNull();
  // The longhands MAY be authored or expanded; tolerate either.
  const shellTop = shell?.paddingTop ?? "";
  const shellBottom = shell?.paddingBottom ?? "";
  // #1751 — the inset arrives as `var(--safe-area-inset-top)` now; `env()`
  // survives only on `:root`. The claim is unchanged: this container declares
  // the top inset.
  expect(shellTop).toContain("var(");
  expect(shellTop).toContain("safe-area-inset-top");
  // Zero, and declared: an empty string here means the longhand is gone
  // and base `.shell`'s inset cascades in. CSSOM may serialize the
  // authored `0` as `0px`, so accept either spelling.
  expect(shellBottom).toMatch(/^0(px)?$/);

  // .topic-bar MUST NOT carry the inset anymore — pin the UX-3 BIS
  // revert so a future operator can't re-introduce the double-clear
  // regression.
  //
  // UX-4 bucket L (commit 17aefeb) DROPPED `.shell-empty-toolbar` from
  // the JSX (Shell.tsx's empty-toolbar fallbacks were replaced by the
  // always-visible ShellChrome bar). The CSS rule was swept as a CSS
  // orphan in the same bucket. The empty-toolbar bar-level
  // double-clear class is now structurally impossible — the rule no
  // longer exists and the selector itself is gone from the JSX.
  const topicBar = await findRulePadding(page, ".topic-bar");
  expect(topicBar).not.toBeNull();
  const topicPadding = `${topicBar?.padding ?? ""} ${topicBar?.paddingTop ?? ""}`;
  // #1751 — STRENGTHENED, not merely re-spelled. `not.toContain("env(")` alone
  // would now pass on `var(--safe-area-inset-top)`, i.e. on exactly the edit it
  // exists to stop, because #1751 moved every consumer onto the token. This
  // band is THE surface vjt's directive singled out: `env(safe-area-inset-top)`
  // is a viewport constant and not position-aware, and `.topic-bar` also renders
  // MID-COLUMN under the mobile header, where an inset would pad it away from a
  // notch it never touches. Reject the inset by NAME, whichever vector carries
  // it.
  expect(topicPadding).not.toContain("safe-area-inset");

  // .bottom-bar MUST NOT carry the inset anymore (container handles
  // the home-indicator clearance via padding-bottom).
  const bottomBar = await findRulePadding(page, ".bottom-bar");
  expect(bottomBar).not.toBeNull();
  const bottomPadding = `${bottomBar?.padding ?? ""} ${bottomBar?.paddingBottom ?? ""}`;
  // Same strengthening as the band above, same reason: the container owns the
  // home-indicator clearance, and after #1751 an inset would arrive here spelled
  // `var(--safe-area-inset-bottom)` and slip straight past an `env(`-only guard.
  expect(bottomPadding).not.toContain("safe-area-inset");
});
