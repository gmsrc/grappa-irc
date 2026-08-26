import { type Mock, vi } from "vitest";

// A recording 2D context plus a hand-cranked rAF, shared by every test that
// asks what `MatrixRain` PAINTS rather than what it renders (#1807).
//
// Lifted out of MatrixRain.test.tsx's stub the moment AdminDebugTab.test.tsx
// needed the same rig: #1807 makes the four drawing knobs per-surface, so the
// assertion that matters most — "the Debug tab paints exactly what it painted
// before" — has to live in the DEBUG tab's own file, driving the REAL five-tap
// gate, not in the component's.
//
// Three jsdom gaps this closes, and each one silently hollows the suite:
//
//   * `getContext` returns null without the `canvas` npm package, and the
//     component's `if (ctx === null) return` fires BEFORE it ever requests a
//     frame — every assertion about the loop then passes for the wrong reason.
//   * jsdom lays nothing out, so `parentElement.clientWidth/Height` read 0 and
//     the component sizes itself to ZERO columns. A spec asserting on painted
//     glyphs would pass against a component painting none.
//   * There is no rAF at all. The callback is captured rather than scheduled,
//     so a test steps frames one at a time and a self-driving loop can never
//     hang the run.

export type CanvasOp =
  | {
      readonly kind: "fillRect";
      readonly style: string;
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
    }
  | {
      readonly kind: "fillText";
      readonly style: string;
      readonly glyph: string;
      readonly x: number;
      readonly y: number;
    };

export type RainHarness = {
  /** Every op recorded since the harness was installed, in paint order. */
  readonly ops: CanvasOp[];
  readonly raf: Mock;
  readonly caf: Mock;
  /** The handle the last `requestAnimationFrame` handed out. */
  readonly handle: () => number;
  /**
   * Run the one frame the component has pending, at `now` ms, and return
   * ONLY the ops that frame painted. `MatrixRain` re-arms at the top of its
   * callback, so the next `frame()` runs the next iteration.
   */
  readonly frame: (now: number) => CanvasOp[];
};

class StubResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

/**
 * Stub the browser surfaces `MatrixRain` needs and hand back the recorder.
 * `width`/`height` are the parent box the canvas sizes itself off, in CSS
 * pixels — pick them so the column count and the row count are obvious.
 *
 * Undone by `vi.unstubAllGlobals()` + `vi.restoreAllMocks()`; a caller that
 * forgets the second one leaks the layout stub into the next file.
 */
export function installRainHarness(width: number, height: number): RainHarness {
  const ops: CanvasOp[] = [];
  let pending: FrameRequestCallback | null = null;
  let handle = 0;

  const raf = vi.fn((cb: FrameRequestCallback) => {
    pending = cb;
    handle += 1;
    return handle;
  });
  const caf = vi.fn();

  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", caf);
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  // Default: no motion preference expressed. A test that wants the OFF arm
  // re-stubs this after installing the harness.
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );

  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(height);

  const ctx = {
    font: "",
    fillStyle: "" as string,
    fillRect(x: number, y: number, w: number, h: number): void {
      ops.push({ kind: "fillRect", style: ctx.fillStyle, x, y, w, h });
    },
    fillText(glyph: string, x: number, y: number): void {
      ops.push({ kind: "fillText", style: ctx.fillStyle, glyph, x, y });
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );

  return {
    ops,
    raf,
    caf,
    handle: () => handle,
    frame(now: number): CanvasOp[] {
      const from = ops.length;
      const cb = pending;
      pending = null;
      cb?.(now);
      return ops.slice(from);
    },
  };
}

/** The `fillText` ops of one frame, in paint order. */
export function texts(
  frame: readonly CanvasOp[],
): readonly Extract<CanvasOp, { kind: "fillText" }>[] {
  return frame.filter(
    (op): op is Extract<CanvasOp, { kind: "fillText" }> => op.kind === "fillText",
  );
}

/** The `fillRect` ops of one frame, in paint order. */
export function rects(
  frame: readonly CanvasOp[],
): readonly Extract<CanvasOp, { kind: "fillRect" }>[] {
  return frame.filter(
    (op): op is Extract<CanvasOp, { kind: "fillRect" }> => op.kind === "fillRect",
  );
}
