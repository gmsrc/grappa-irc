import { describe, expect, it } from "vitest";
import { ruleBody, themeCss } from "./helpers/themeCss";

// #1772 — the stylesheet half of "the shell does not move while the long-press
// menu is open", asserted at SOURCE level (the railMenuSafeArea /
// mediaViewerTouchAction precedent): jsdom applies no stylesheet, so a
// computed-style oracle would read every one of these back as empty whether or
// not the rule exists, and Playwright's webkit does not reproduce UIKit's
// gesture model either. These are invisible in every gate we run and only bite
// on a real phone — which is exactly why they need a guard that fails in CI.
//
// Two declarations, opposite directions, one cause. The menu now arms the iOS
// touch lock (see `lib/overlayScrollLock.ts`), which puts `html.overlay-open
// body { touch-action: none }` over the portal root the menu lives in:
//
//   * the BACKDROP must claim the gesture and give nothing back — it is a
//     full-viewport shield, and at the `auto` it had by omission a drag on it
//     went straight to UIKit as a page pan (the reported symptom: the content
//     slid out from under a menu that stayed at its fixed coordinates);
//   * the MENU must give the pan back, because it is a real scroller
//     (`max-height` + `overflow-y: auto`) and the blanket it now sits under
//     would otherwise refuse the scroll — fixing the pan by removing it.
//
// The menu is the one overlay scroller that PORTALS to <body>, outside
// `.shell-mobile { touch-action: none }`, which is why it is the only one that
// had no carve-out to begin with.

describe("#1772 context menu touch-action contract", () => {
  it("the backdrop claims the whole touch stream", () => {
    expect(ruleBody(".context-menu-backdrop")).toMatch(/touch-action:\s*none/);
  });

  it("the menu re-opens vertical panning for its own overflow", () => {
    expect(ruleBody(".context-menu")).toMatch(/touch-action:\s*pan-y/);
  });

  it("the items carry the carve-out too — they are the hit-test target", () => {
    // #913's lesson at `.rail-actions-menu *`, which shipped scroller-only
    // first and did not work: touch-action does not inherit, so every row sits
    // at `auto` under a `none` ancestor and iOS elects the gesture consumer
    // from the hit-test target's own value.
    expect(themeCss).toMatch(/\.context-menu \*\s*\{[^}]*touch-action:\s*pan-y/);
  });
});
