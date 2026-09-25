import { describe, expect, it } from "vitest";
import { coarsePointerBlocks, mediaGatedBlocks, themeCss } from "./helpers/themeCss";

// issue 2296 — the × on every sidebar row (channel → leave, query → close,
// network header → disconnect, pseudo-row → forceParted) was always painted,
// next to the unread badge on every row. It is now shown only while the row is
// hovered or holds keyboard focus, on a fine, hover-capable pointer only.
//
// WHY A SOURCE-LEVEL TEST. jsdom applies no stylesheet and Playwright cannot
// emulate `(hover: none)` (`page.emulateMedia()` has no `hover` key), so what
// is deterministic is what the cascade is ASKED to do. Same posture as
// hoverGate.test.ts; the before/after screenshots in the PR are the witness
// for what a browser paints.
const stripped = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
// `(hover: hover) and (pointer: fine)`, not `(hover: hover)` alone: some
// Android phones/tablets (stylus, some browsers) report `hover: hover` while a
// finger is the primary pointer, and a touch user must keep the always-visible
// ×. A plain `(hover: hover)` block does not count as the gate.
const gated = mediaGatedBlocks(
  /@media\s*\(\s*hover\s*:\s*hover\s*\)\s*and\s*\(\s*pointer\s*:\s*fine\s*\)\s*\{/g,
  "@media (hover: hover) and (pointer: fine)",
).join("\n");

const HIDE = /\.sidebar-network-section li \.sidebar-close\s*\{([^}]*)\}/;
const REVEAL_HOVER = ".sidebar-network-section li:hover .sidebar-close";
const REVEAL_FOCUS = ".sidebar-network-section li:has(:focus-visible) .sidebar-close";

describe("issue 2296 — sidebar × is revealed on row hover, not always painted", () => {
  it("hides the × behind a (hover: hover) and (pointer: fine) gate", () => {
    const body = HIDE.exec(gated)?.[1] ?? "";
    expect(body).toMatch(/opacity:\s*0\s*(;|$)/);
  });

  // opacity, never display/visibility: `display: none` reflows the row (the
  // unread badge jumps on hover), and both it and `visibility: hidden` drop the
  // button from the tab order — so the focus reveal could never fire.
  it("keeps the × in layout and in the tab order while hidden", () => {
    const body = HIDE.exec(gated)?.[1] ?? "";
    expect(body).not.toMatch(/display\s*:/);
    expect(body).not.toMatch(/visibility\s*:/);
  });

  it("reveals the × on row hover and on keyboard focus within the row", () => {
    expect(gated).toContain(REVEAL_HOVER);
    expect(gated).toContain(REVEAL_FOCUS);
    const reveal = new RegExp(
      `${REVEAL_FOCUS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    ).exec(gated);
    expect(reveal?.[1] ?? "").toMatch(/opacity:\s*1\s*(;|$)/);
  });

  // Reported in the interactive test: `:focus-within` also matches after a
  // MOUSE click (the clicked window button keeps focus), so the × of the row
  // just clicked stayed painted after the pointer left, until focus moved to
  // e.g. the compose box. `:focus-visible` is the browser's own "this focus
  // came from the keyboard" heuristic, so only a keyboard user pins it.
  it("does not pin the × on a row that was merely clicked", () => {
    expect(gated).not.toMatch(/li:focus-within \.sidebar-close/);
  });

  // Touch has no hover: the hide must not escape the gate, or a phone loses
  // the × outright. Counted across the whole sheet, not just "one is gated".
  it("never hides the × outside the hover gate", () => {
    const total = stripped.match(new RegExp(HIDE.source, "g"))?.length ?? 0;
    const inGate = gated.match(new RegExp(HIDE.source, "g"))?.length ?? 0;
    expect(total).toBe(inGate);
    expect(coarsePointerBlocks().join("\n")).not.toMatch(HIDE);
  });
});
