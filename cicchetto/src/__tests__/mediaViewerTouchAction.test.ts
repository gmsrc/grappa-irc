import { describe, expect, it } from "vitest";
import { DRAGGING_CLASS } from "../lib/mediaViewerGesture";
import { ruleBody } from "./helpers/themeCss";

// #1438 — the stylesheet half of swipe-to-dismiss, asserted at SOURCE level
// (the ipadSafeArea/railExpandedHome precedent): jsdom applies no stylesheet,
// so a computed-style oracle here would read the property back as empty
// whether or not the rule exists.
//
// Both declarations are invisible in every unit and e2e run and only bite on a
// real phone, which is exactly why they need a guard that fails in CI: a drag
// with no `touch-action: none` still dismisses in Playwright while iOS drags
// its own chrome in behind the modal, and a live snap-back transition still
// leaves the modal in the right place while making it lag 180ms behind the
// finger. Neither symptom is reachable from a headless browser.

describe("media viewer — swipe-to-dismiss stylesheet contract (#1438)", () => {
  it("claims the whole touch stream on the modal container", () => {
    // On the CONTAINER, not per media element: the UA intersects touch-action
    // down the ancestor chain, so this one declaration is what covers the
    // <video> as well as the <img>.
    expect(ruleBody(".media-viewer-modal")).toMatch(/touch-action:\s*none/);
  });

  it("declares the spring-back transition an uncommitted drag returns on", () => {
    expect(ruleBody(".media-viewer-modal")).toMatch(/transition:\s*transform/);
  });

  it("drops that transition under the class the binder writes, so the modal tracks the finger", () => {
    // Looked up through the exported constant on purpose: renaming the class
    // in the module without renaming the rule is the failure this catches, and
    // ruleBody throws on a missing selector rather than passing vacuously.
    expect(ruleBody(`.${DRAGGING_CLASS}`)).toMatch(/transition:\s*none/);
  });
});
