import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminDebugTab, { ADM_RAIN_LOOK } from "../AdminDebugTab";
import { installRainHarness, type RainHarness, rects, texts } from "./helpers/canvasOps";

// #1773 — a REGRESSION guard for a move that is outside the issue's mandate.
//
// The credits easter egg needed the falling-character effect that already
// existed as `src/admin/MatrixRain.tsx`, with one consumer: this tab's
// phosphor panel. Rather than copy it, #1773 promoted it to `src/MatrixRain
// .tsx` and gave it two required props. tsc proves the props are PASSED; it
// cannot prove they still carry the values this tab's stylesheet and any
// future spec key off — a wrong string compiles perfectly.
//
// So this pins the values, from the tab, through the real five-tap gate. The
// tab had no test at all before, which is exactly why the move needed one.
//
// #1807 widened the same guard to the DRAWING, and that is now the load-
// bearing case in this file. The credits modal needed the rain louder on all
// four knobs; making them per-surface is what keeps this panel out of it, and
// nothing in the type system says a future edit cannot quietly hand the loud
// look to both callers. The panel rains BEHIND readouts an operator is trying
// to read, so "unchanged" here is a requirement and not tidiness — and the
// only honest way to assert it is on what reaches the canvas.

// 4 columns of 14px, 40 rows deep — deep enough that no column reaches the
// bottom within two frames, so the random reset never fires.
const BOX_W = 56;
const BOX_H = 560;

describe("AdminDebugTab phosphor panel (#1773 — MatrixRain promotion)", () => {
  let rain: RainHarness;

  beforeEach(() => {
    rain = installRainHarness(BOX_W, BOX_H);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the rain behind its own five-tap gate, off by default", () => {
    render(() => <AdminDebugTab />);

    // The pre-state, asserted before the gesture: without it, a rain that
    // never appears and a rain that was always there read the same.
    expect(screen.queryByTestId("admin-matrix-rain")).toBeNull();
  });

  it("still renders the promoted MatrixRain with the admin class and test id", () => {
    const { container } = render(() => <AdminDebugTab />);

    const panel = container.querySelector(".adm-matrix");
    expect(panel).not.toBeNull();
    for (let i = 0; i < 5; i++) {
      fireEvent.click(panel as Element);
    }

    const rainLayer = screen.getByTestId("admin-matrix-rain");
    expect(rainLayer.className).toBe("adm-rain");
    expect(rainLayer.querySelector("canvas")).not.toBeNull();
  });

  it("asks for the four knobs #1773 hardcoded, at the values measured on 4c9270c5", () => {
    // The pin. #1807 turned these four literals into data; if the credits
    // modal's louder numbers ever leak in here, this is the line that says so
    // — and it says WHICH knob moved, which the drawing assertion below
    // cannot.
    expect(ADM_RAIN_LOOK).toEqual({
      glyphAlpha: 0.18,
      fadeAlpha: 0.1,
      leader: null,
      rowsPerFrame: 1,
    });
  });

  it("paints the panel exactly as it did before the knobs became per-surface", () => {
    const { container } = render(() => <AdminDebugTab />);
    const panel = container.querySelector(".adm-matrix");
    for (let i = 0; i < 5; i++) {
      fireEvent.click(panel as Element);
    }

    const first = rain.frame(1_000);

    // ONE rect, and it is the wash over the whole canvas. A second rect would
    // be the leader's punch — the credits look's tell — arriving on a surface
    // that must stay readable-through.
    expect(rects(first)).toEqual([
      { kind: "fillRect", style: "rgba(0, 0, 0, 0.1)", x: 0, y: 0, w: BOX_W, h: BOX_H },
    ]);

    // One glyph per column, every one at the same dim alpha: no bright head,
    // no demoted second draw.
    const glyphs = texts(first);
    expect(glyphs.map((op) => op.x)).toEqual([0, 14, 28, 42]);
    expect(glyphs.map((op) => op.y)).toEqual([0, 0, 0, 0]);
    expect([...new Set(glyphs.map((op) => op.style))]).toEqual(["rgba(255, 176, 0, 0.18)"]);

    // And still a whole row per frame — the 0.7x is the credits modal's, and
    // a shared slowdown would make the diagnostics panel drift too.
    const second = rain.frame(2_000);
    expect(rects(second)).toHaveLength(1);
    expect(texts(second).map((op) => op.y)).toEqual([14, 14, 14, 14]);
  });
});
