import { render } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MatrixRain, { type MatrixRainLook } from "../MatrixRain";
import { installRainHarness, type RainHarness, rects, texts } from "./helpers/canvasOps";

// #1773 moved this component out of `src/admin/` and gave it two required
// props, because the credits easter egg is a second consumer of the same
// falling-character effect. It had no tests before the move; these pin the
// three properties the move must not have broken, and the one the credits
// modal newly depends on.
//
// The BATTERY contract is the one that matters most here: the credits modal
// is a full-screen overlay someone opens, watches, and closes, and a rAF loop
// that survives the close burns a phone behind a dismissed dialog. The rest
// of the suite runs with the loop mounted, so a leak here would be invisible.
//
// #1807 added the third required prop — `look`, the four drawing knobs — and
// with it the cases below that assert what the component PAINTS. They use
// SYNTHETIC looks on purpose: the values each surface actually ships are that
// surface's business, and are pinned where the surface is (AdminDebugTab
// .test.tsx for the phosphor panel, creditsRain.test.ts for the modal). What
// belongs here is only the contract between a look and the canvas.

// 4 columns of 14px, 40 rows deep — deep enough that no column reaches the
// bottom within the frame counts below, so the random reset never fires and
// the only nondeterminism left is which glyph is chosen.
const BOX_W = 56;
const BOX_H = 560;
const FONT = 14;

const PLAIN: MatrixRainLook = { glyphAlpha: 0.18, fadeAlpha: 0.1, leader: null, rowsPerFrame: 1 };
const LOUD: MatrixRainLook = {
  glyphAlpha: 0.3,
  fadeAlpha: 0.06,
  leader: "rgba(255, 255, 255, 0.95)",
  rowsPerFrame: 0.7,
};

describe("MatrixRain (#1773 — shared by the Debug tab and the credits roll)", () => {
  let rain: RainHarness;

  beforeEach(() => {
    rain = installRainHarness(BOX_W, BOX_H);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("wears the class and the test id its caller chose", () => {
    // The whole point of the props: each surface is addressable on its own and
    // styles itself. A default would have silently handed the second caller
    // the first caller's stylesheet hook.
    const { getByTestId } = render(() => (
      <MatrixRain class="credits-rain" testId="credits-matrix-rain" look={() => PLAIN} />
    ));

    const wrapper = getByTestId("credits-matrix-rain");
    expect(wrapper.className).toBe("credits-rain");
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
    expect(wrapper.querySelector("canvas")).not.toBeNull();
  });

  it("cancels its animation frame when it unmounts", () => {
    // The battery contract. Asserted on the HANDLE, not merely on "cancel was
    // called": cancelling some other frame would satisfy a call-count check
    // while leaving this loop running forever.
    const [shown, setShown] = createSignal(true);
    render(() => (
      <Show when={shown()}>
        <MatrixRain class="credits-rain" testId="credits-matrix-rain" look={() => PLAIN} />
      </Show>
    ));

    expect(rain.raf).toHaveBeenCalled();
    const armed = rain.handle();
    expect(rain.caf).not.toHaveBeenCalled();

    setShown(false);

    expect(rain.caf).toHaveBeenCalledWith(armed);
  });

  it("never starts a loop when the reader asked for reduced motion", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );

    render(() => (
      <MatrixRain class="credits-rain" testId="credits-matrix-rain" look={() => PLAIN} />
    ));

    // OFF, not slowed — and the canvas is still in the DOM, because the
    // wrapper is what the stylesheet positions. Absence of the loop is the
    // assertion, so it has to be the frame request that is missing.
    expect(rain.raf).not.toHaveBeenCalled();
  });

  it("paints one glyph per column and nothing else when the look has no leader", () => {
    // `leader: null` is the shape the Debug tab depends on: the wash is the
    // only rect, every glyph carries the same alpha, and there is exactly one
    // per column. Anything extra — a punch, a second draw, a brighter head —
    // would be a change to a surface nobody asked to change.
    render(() => <MatrixRain class="adm-rain" testId="admin-matrix-rain" look={() => PLAIN} />);

    const frame = rain.frame(1_000);

    expect(rects(frame)).toEqual([
      { kind: "fillRect", style: "rgba(0, 0, 0, 0.1)", x: 0, y: 0, w: BOX_W, h: BOX_H },
    ]);
    const painted = texts(frame);
    expect(painted.map((op) => op.x)).toEqual([0, 14, 28, 42]);
    expect(painted.map((op) => op.y)).toEqual([0, 0, 0, 0]);
    expect([...new Set(painted.map((op) => op.style))]).toEqual(["rgba(255, 176, 0, 0.18)"]);
  });

  it("demotes last frame's head to the trail colour before painting the new one", () => {
    // The leader is only a leader if the glyph BEHIND it is dimmer. The wash
    // alone cannot do that — it decays whatever colour is already there, so a
    // near-opaque head would leave a near-opaque trail and `glyphAlpha` and
    // `leader` would name the same pixel at two ages instead of two things.
    render(() => (
      <MatrixRain class="credits-rain" testId="credits-matrix-rain" look={() => LOUD} />
    ));

    const first = rain.frame(1_000);
    // Nothing to demote yet: one head per column, no punch.
    expect(rects(first)).toHaveLength(1);
    const heads = texts(first);
    expect(heads.map((op) => op.style)).toEqual(Array(4).fill(LOUD.leader));

    const second = rain.frame(2_000);

    // The wash, then one opaque punch per column over the cell the previous
    // head occupies — `fillText`'s baseline is alphabetic, so that cell sits
    // ABOVE the y it was drawn at.
    expect(rects(second)).toEqual([
      { kind: "fillRect", style: "rgba(0, 0, 0, 0.06)", x: 0, y: 0, w: BOX_W, h: BOX_H },
      { kind: "fillRect", style: "#000", x: 0, y: -FONT, w: FONT, h: 18 },
      { kind: "fillRect", style: "#000", x: 14, y: -FONT, w: FONT, h: 18 },
      { kind: "fillRect", style: "#000", x: 28, y: -FONT, w: FONT, h: 18 },
      { kind: "fillRect", style: "#000", x: 42, y: -FONT, w: FONT, h: 18 },
    ]);

    // Per column: the SAME glyph repainted dim where the head was, then the
    // new head one row down. Repainted rather than re-rolled, so the demotion
    // reads as a colour cooling and not as a flicker.
    const painted = texts(second);
    for (let i = 0; i < 4; i++) {
      const demoted = painted[i * 2];
      const head = painted[i * 2 + 1];
      expect(demoted).toEqual({
        kind: "fillText",
        style: "rgba(255, 176, 0, 0.3)",
        glyph: heads[i]?.glyph,
        x: i * FONT,
        y: 0,
      });
      expect(head?.style).toBe(LOUD.leader);
      expect(head?.y).toBe(FONT);
    }
  });

  it("advances by a fractional row, rounding only where the glyph lands", () => {
    // vjt asked for 0.7x, and NOT by raising the frame budget: at ~6fps the
    // columns visibly step. So the row counter is fractional and the rounding
    // happens at paint time — which means the head holds a row on some frames
    // instead of moving every one.
    const rowsOf = (look: MatrixRainLook): number[] => {
      const { unmount } = render(() => (
        <MatrixRain class="credits-rain" testId="credits-matrix-rain" look={() => look} />
      ));
      const rows: number[] = [];
      for (let i = 1; i <= 10; i++) {
        const head = texts(rain.frame(i * 1_000)).at(-1);
        rows.push((head?.y ?? 0) / FONT);
      }
      unmount();
      return rows;
    };

    const fast = rowsOf(PLAIN);
    expect(fast).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const slow = rowsOf(LOUD);
    // 0.7x the ground covered over the same nine advances, and — the part a
    // whole-row implementation could never produce — some frames repeat a row.
    expect(slow.at(-1)).toBe(Math.round(0.7 * 9));
    expect(new Set(slow).size).toBeLessThan(slow.length);
    expect([...slow].sort((a, b) => a - b)).toEqual(slow);
  });

  it("reads the look once per drawn frame, so the caller needs no second clock", () => {
    // This is what lets the credits burst ride the CSS animation's own phase:
    // the caller answers "what does it look like right now" inside the rAF
    // that already exists. A `setTimeout` would be a second clock, and in a
    // backgrounded tab rAF stops while timers do not.
    let current = PLAIN;
    render(() => (
      <MatrixRain class="credits-rain" testId="credits-matrix-rain" look={() => current} />
    ));

    expect(rects(rain.frame(1_000))[0]?.style).toBe("rgba(0, 0, 0, 0.1)");
    current = LOUD;
    expect(rects(rain.frame(2_000))[0]?.style).toBe("rgba(0, 0, 0, 0.06)");
  });
});
