import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminDebugTab from "../AdminDebugTab";

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

class StubResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

describe("AdminDebugTab phosphor panel (#1773 — MatrixRain promotion)", () => {
  beforeEach(() => {
    // Never invoke the callback: a self-driving loop in jsdom is an infinite
    // one, and the frame's CONTENT is MatrixRain.test.tsx's subject, not this
    // file's.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
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

    const rain = screen.getByTestId("admin-matrix-rain");
    expect(rain.className).toBe("adm-rain");
    expect(rain.querySelector("canvas")).not.toBeNull();
  });
});
