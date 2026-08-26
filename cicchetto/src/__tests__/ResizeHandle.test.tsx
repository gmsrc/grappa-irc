import { render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ResizeHandle from "../ResizeHandle";

// Helpers to fire PointerEvent-shaped events. jsdom's PointerEvent has
// existed since v16; setPointerCapture / releasePointerCapture exist but
// are no-ops in jsdom — we only assert the side-effect (CSS var +
// localStorage), not the capture mechanism itself.

function makePointerEvent(
  type: string,
  init: PointerEventInit & { clientX: number },
): PointerEvent {
  // PointerEvent constructor isn't reliably available in jsdom; fall back
  // to a MouseEvent + augmenting fields. The handler only reads
  // .pointerId, .clientX, .button, .preventDefault.
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: init.button ?? 0,
    clientX: init.clientX,
  });
  Object.defineProperty(e, "pointerId", { value: init.pointerId ?? 1 });
  return e as unknown as PointerEvent;
}

function mountInAside(side: "left" | "right", asideRect: Partial<DOMRect>) {
  const aside = document.createElement("aside");
  aside.className = side === "left" ? "shell-sidebar" : "shell-members";
  Object.defineProperty(aside, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      right: 256,
      top: 0,
      bottom: 600,
      width: 256,
      height: 600,
      x: 0,
      y: 0,
      toJSON() {},
      ...asideRect,
    }),
  });
  document.body.appendChild(aside);
  const rendered = render(() => <ResizeHandle side={side} />, { container: aside });
  return { aside, rendered };
}

describe("ResizeHandle component", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    document.documentElement.style.removeProperty("--sidebar-width");
    document.documentElement.style.removeProperty("--members-width");
    document.documentElement.classList.remove("resize-dragging");
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });
  });

  it("renders as a separator with the correct aria label for left", () => {
    const { aside } = mountInAside("left", { left: 0, right: 256 });
    const handle = aside.querySelector(".resize-handle") as HTMLElement;
    expect(handle).toBeTruthy();
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-label")).toBe("Resize sidebar");
    expect(handle.classList.contains("resize-handle-left")).toBe(true);
  });

  it("renders the correct aria label for right side", () => {
    const { aside } = mountInAside("right", { left: 800, right: 1024 });
    const handle = aside.querySelector(".resize-handle") as HTMLElement;
    expect(handle.getAttribute("aria-label")).toBe("Resize members pane");
    expect(handle.classList.contains("resize-handle-right")).toBe(true);
  });

  it("applies stored width on mount via CSS var", () => {
    localStorage.setItem("cicchetto.sidebarWidth", "300");
    mountInAside("left", { left: 0, right: 300 });
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("300px");
  });

  it("on pointerdown→move→up: mutates CSS var live and persists on up (left)", () => {
    const { aside } = mountInAside("left", { left: 0, right: 256 });
    const handle = aside.querySelector(".resize-handle") as HTMLElement;

    handle.dispatchEvent(makePointerEvent("pointerdown", { clientX: 256 }));
    expect(document.documentElement.classList.contains("resize-dragging")).toBe(true);

    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 320 }));
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("320px");

    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 320 }));
    expect(localStorage.getItem("cicchetto.sidebarWidth")).toBe("320");
    expect(document.documentElement.classList.contains("resize-dragging")).toBe(false);
  });

  it("clamps to MIN_WIDTH_PX (160) when dragged below min (left)", () => {
    const { aside } = mountInAside("left", { left: 0, right: 256 });
    const handle = aside.querySelector(".resize-handle") as HTMLElement;
    handle.dispatchEvent(makePointerEvent("pointerdown", { clientX: 256 }));
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 50 }));
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("160px");
    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 50 }));
    expect(localStorage.getItem("cicchetto.sidebarWidth")).toBe("160");
  });

  it("clamps to 50% viewport when dragged past max (left)", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    const { aside } = mountInAside("left", { left: 0, right: 256 });
    const handle = aside.querySelector(".resize-handle") as HTMLElement;
    handle.dispatchEvent(makePointerEvent("pointerdown", { clientX: 256 }));
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 9999 }));
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("400px");
    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 9999 }));
    expect(localStorage.getItem("cicchetto.sidebarWidth")).toBe("400");
  });

  it("computes right-side width as (asideRect.right - clientX)", () => {
    // Members aside spans x=[800..1024]. Drag handle clientX=750 → width = 1024 - 750 = 274.
    const { aside } = mountInAside("right", { left: 800, right: 1024 });
    const handle = aside.querySelector(".resize-handle") as HTMLElement;
    handle.dispatchEvent(makePointerEvent("pointerdown", { clientX: 800 }));
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 750 }));
    expect(document.documentElement.style.getPropertyValue("--members-width")).toBe("274px");
    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 750 }));
    expect(localStorage.getItem("cicchetto.membersWidth")).toBe("274");
  });

  it("ignores non-primary button pointerdown", () => {
    const { aside } = mountInAside("left", { left: 0, right: 256 });
    const handle = aside.querySelector(".resize-handle") as HTMLElement;
    handle.dispatchEvent(makePointerEvent("pointerdown", { clientX: 256, button: 2 }));
    expect(document.documentElement.classList.contains("resize-dragging")).toBe(false);
  });

  // issue 1827 — mounting used to write the CSS var unconditionally, which
  // defeated the per-tier CSS default exactly the way main.tsx's boot call
  // did. A handle that has never been dragged must leave the var alone.
  it("writes NO CSS var on mount when nothing is stored", () => {
    mountInAside("left", { left: 0, right: 256 });
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("");
  });

  describe("in the short-landscape tier", () => {
    beforeEach(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 844 });
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: (q: string) => ({
          matches: q.includes("max-height: 500px"),
          media: q,
          addEventListener() {},
          removeEventListener() {},
        }),
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(window, "matchMedia");
    });

    // The whole point of the issue: in this tier the drag used to write a var
    // the grid did not reference, so the column never moved. It moves now.
    it("moves the column on drag, within the tier's own bounds", () => {
      const { aside } = mountInAside("left", { left: 0, right: 112 });
      const handle = aside.querySelector(".resize-handle") as HTMLElement;
      handle.dispatchEvent(makePointerEvent("pointerdown", { clientX: 112 }));
      window.dispatchEvent(makePointerEvent("pointermove", { clientX: 180 }));
      expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("180px");
      window.dispatchEvent(makePointerEvent("pointerup", { clientX: 180 }));
      expect(localStorage.getItem("cicchetto.sidebarWidth")).toBe("180");
    });

    it("floors at the tier constant, below the 160px desktop floor", async () => {
      const { COMPACT_MIN_WIDTH_PX } = await import("../lib/sidebarWidths");
      const { aside } = mountInAside("left", { left: 0, right: 112 });
      const handle = aside.querySelector(".resize-handle") as HTMLElement;
      handle.dispatchEvent(makePointerEvent("pointerdown", { clientX: 112 }));
      window.dispatchEvent(makePointerEvent("pointermove", { clientX: 10 }));
      expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe(
        `${COMPACT_MIN_WIDTH_PX}px`,
      );
    });

    // The live drag, the persisted value and aria-valuemax all read the same
    // bound. Before this they were three separate copies of `innerWidth / 2`
    // and only one of them could be made tier-aware.
    it("announces the tier cap as aria-valuemax, matching the drag clamp", () => {
      const { aside } = mountInAside("left", { left: 0, right: 112 });
      const handle = aside.querySelector(".resize-handle") as HTMLElement;
      expect(handle.getAttribute("aria-valuemax")).toBe("211");

      handle.dispatchEvent(makePointerEvent("pointerdown", { clientX: 112 }));
      window.dispatchEvent(makePointerEvent("pointermove", { clientX: 9999 }));
      expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("211px");
    });
  });
});
