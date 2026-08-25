import { render } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MatrixRain from "../MatrixRain";

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

// jsdom implements none of these. `ResizeObserver` the component constructs
// unconditionally; the rAF pair it drives the loop with; and the 2D context.
//
// The canvas stub is NOT optional scaffolding, and finding that out is what
// this file bought: jsdom's `getContext` returns null without the `canvas`
// npm package, and the component's `if (ctx === null) return` fires BEFORE it
// ever requests a frame. Unstubbed, the unmount case below passes for the
// wrong reason — there is nothing to cancel because nothing ever started.
class StubResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

function stubCanvas2d(): void {
  const ctx = {
    font: "",
    fillStyle: "",
    fillRect: (): void => {},
    fillText: (): void => {},
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
}

describe("MatrixRain (#1773 — shared by the Debug tab and the credits roll)", () => {
  let raf: ReturnType<typeof vi.fn>;
  let caf: ReturnType<typeof vi.fn>;
  let handle = 0;

  beforeEach(() => {
    handle = 0;
    // Hand back a fresh handle and NEVER call the callback: one frame is all
    // this needs to prove, and a self-driving loop in jsdom is an infinite
    // one.
    raf = vi.fn(() => {
      handle += 1;
      return handle;
    });
    caf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", caf);
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    stubCanvas2d();
    // Default: no motion preference expressed.
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("wears the class and the test id its caller chose", () => {
    // The whole point of the two props: each surface is addressable on its
    // own and styles itself. A default would have silently handed the second
    // caller the first caller's stylesheet hook.
    const { getByTestId } = render(() => (
      <MatrixRain class="credits-rain" testId="credits-matrix-rain" />
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
        <MatrixRain class="credits-rain" testId="credits-matrix-rain" />
      </Show>
    ));

    expect(raf).toHaveBeenCalled();
    const armed = handle;
    expect(caf).not.toHaveBeenCalled();

    setShown(false);

    expect(caf).toHaveBeenCalledWith(armed);
  });

  it("never starts a loop when the reader asked for reduced motion", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );

    render(() => <MatrixRain class="credits-rain" testId="credits-matrix-rain" />);

    // OFF, not slowed — and the canvas is still in the DOM, because the
    // wrapper is what the stylesheet positions. Absence of the loop is the
    // assertion, so it has to be the frame request that is missing.
    expect(raf).not.toHaveBeenCalled();
  });
});
