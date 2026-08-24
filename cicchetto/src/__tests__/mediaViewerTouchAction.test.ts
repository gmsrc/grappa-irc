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

// #1764 — the text-source variant. Same standing as the block above: jsdom
// applies no stylesheet, so these are SOURCE-level assertions on rules that are
// invisible in every unit and e2e run and only bite on a real phone.
describe("media viewer — text source stylesheet contract (#1764)", () => {
  it("re-opens touch panning on the text variant, which the base rule closes", () => {
    // `.media-viewer-modal` claims the whole touch stream with `touch-action:
    // none` for the image/video case. Here the BODY scrolls, and a descendant
    // cannot widen what an ancestor narrowed — the UA intersects down the
    // chain — so the re-opening has to happen on the modal element itself.
    expect(ruleBody(".media-viewer-modal--text")).toMatch(/touch-action:\s*pan-x\s+pan-y/);
  });

  it("keeps the pane's overscroll to itself so a drag past the end is not the page's", () => {
    expect(ruleBody(".media-viewer-text")).toMatch(/overscroll-behavior:\s*contain/);
  });

  it("makes the pane the scroller — the base body is overflow:hidden", () => {
    expect(ruleBody(".media-viewer-text")).toMatch(/overflow:\s*auto/);
  });

  it("does not wrap: a wrapped line would put N source rows against one gutter number", () => {
    expect(ruleBody(".media-viewer-text-source")).toMatch(/white-space:\s*pre/);
    expect(ruleBody(".media-viewer-text-gutter")).toMatch(/white-space:\s*pre/);
  });

  it("pins the gutter to the left edge, so panning a long line does not scroll the numbers away", () => {
    const gutter = ruleBody(".media-viewer-text-gutter");
    expect(gutter).toMatch(/position:\s*sticky/);
    expect(gutter).toMatch(/left:\s*0/);
  });

  // The alignment guarantee, and the reason it is `font: inherit` on BOTH
  // rather than the same tokens spelled twice: a <pre> carries a UA
  // font-family/font-size that would otherwise win, and two independently
  // spelled copies are two things that can drift. One inherited metric means
  // gutter row N and source row N are the same height by construction.
  it("takes ONE font metric from the pane, so number N sits beside line N", () => {
    expect(ruleBody(".media-viewer-text-gutter")).toMatch(/font:\s*inherit/);
    expect(ruleBody(".media-viewer-text-source")).toMatch(/font:\s*inherit/);
    expect(ruleBody(".media-viewer-text")).toMatch(/font-family:\s*var\(--font-mono\)/);
  });
});
