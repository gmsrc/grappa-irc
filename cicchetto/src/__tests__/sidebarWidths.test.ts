import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirror-shape of fontSize.test.ts. Imports are dynamic so each `beforeEach`
// can reset localStorage + the CSS vars and re-import the module fresh.

const STORAGE_KEY_LEFT = "cicchetto.sidebarWidth";
const STORAGE_KEY_RIGHT = "cicchetto.membersWidth";
const CSS_VAR_LEFT = "--sidebar-width";
const CSS_VAR_RIGHT = "--members-width";

// issue 1827 — the short-landscape tier predicate, mirrored from
// themes/default.css. jsdom implements no matchMedia at all, so the desktop
// cases below leave it UNDEFINED on purpose: that is the "not in the tier"
// arm, and it also pins the module's absent-matchMedia guard.
function enterShortLandscape(innerWidth: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: innerWidth });
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
}

describe("sidebarWidths module", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.style.removeProperty(CSS_VAR_LEFT);
    document.documentElement.style.removeProperty(CSS_VAR_RIGHT);
    // jsdom's window.innerWidth defaults to 1024.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });
    // Undo any tier stub a previous test installed.
    Reflect.deleteProperty(window, "matchMedia");
  });

  describe("getSidebarWidth()", () => {
    it("returns 256 default for left when localStorage empty", async () => {
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      expect(getSidebarWidth("left")).toBe(256);
    });

    it("returns 224 default for right when localStorage empty", async () => {
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      expect(getSidebarWidth("right")).toBe(224);
    });

    it("returns stored value for left when set", async () => {
      localStorage.setItem(STORAGE_KEY_LEFT, "300");
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      expect(getSidebarWidth("left")).toBe(300);
    });

    it("returns stored value for right when set", async () => {
      localStorage.setItem(STORAGE_KEY_RIGHT, "280");
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      expect(getSidebarWidth("right")).toBe(280);
    });

    it("clamps stored value below MIN_WIDTH_PX (160) up to 160", async () => {
      localStorage.setItem(STORAGE_KEY_LEFT, "50");
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      expect(getSidebarWidth("left")).toBe(160);
    });

    it("clamps stored value above 50% viewport down to viewport/2", async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
      localStorage.setItem(STORAGE_KEY_LEFT, "999");
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      expect(getSidebarWidth("left")).toBe(400);
    });

    it("returns default when stored value is non-numeric", async () => {
      localStorage.setItem(STORAGE_KEY_LEFT, "garbage");
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      expect(getSidebarWidth("left")).toBe(256);
    });
  });

  describe("setSidebarWidth()", () => {
    it("writes localStorage + CSS var on <html> for left", async () => {
      const { setSidebarWidth } = await import("../lib/sidebarWidths");
      const stored = setSidebarWidth("left", 320);
      expect(stored).toBe(320);
      expect(localStorage.getItem(STORAGE_KEY_LEFT)).toBe("320");
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_LEFT)).toBe("320px");
    });

    it("writes localStorage + CSS var on <html> for right", async () => {
      const { setSidebarWidth } = await import("../lib/sidebarWidths");
      const stored = setSidebarWidth("right", 260);
      expect(stored).toBe(260);
      expect(localStorage.getItem(STORAGE_KEY_RIGHT)).toBe("260");
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_RIGHT)).toBe("260px");
    });

    it("clamps input below min before persisting", async () => {
      const { setSidebarWidth } = await import("../lib/sidebarWidths");
      const stored = setSidebarWidth("left", 50);
      expect(stored).toBe(160);
      expect(localStorage.getItem(STORAGE_KEY_LEFT)).toBe("160");
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_LEFT)).toBe("160px");
    });

    it("clamps input above max before persisting", async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
      const { setSidebarWidth } = await import("../lib/sidebarWidths");
      const stored = setSidebarWidth("left", 9999);
      expect(stored).toBe(400);
      expect(localStorage.getItem(STORAGE_KEY_LEFT)).toBe("400");
    });

    it("rounds fractional input", async () => {
      const { setSidebarWidth } = await import("../lib/sidebarWidths");
      const stored = setSidebarWidth("left", 280.7);
      expect(stored).toBe(281);
      expect(localStorage.getItem(STORAGE_KEY_LEFT)).toBe("281");
    });
  });

  describe("clampWidth()", () => {
    it("returns min when input < min", async () => {
      const { clampWidth, MIN_WIDTH_PX } = await import("../lib/sidebarWidths");
      expect(clampWidth(0)).toBe(MIN_WIDTH_PX);
    });

    it("returns viewport-max when input > viewport/2", async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
      const { clampWidth } = await import("../lib/sidebarWidths");
      expect(clampWidth(9999)).toBe(300);
    });

    it("returns input rounded when within bounds", async () => {
      const { clampWidth } = await import("../lib/sidebarWidths");
      expect(clampWidth(287.4)).toBe(287);
    });
  });

  describe("applySidebarWidthsFromStorage()", () => {
    // issue 1827 — this replaces a test that asserted the OPPOSITE ("writes
    // both CSS vars from defaults on cold load", pinning 256px/224px with
    // localStorage empty). That behaviour is the defect: the var was written
    // for EVERY user, so `var(--sidebar-width, 8rem)` in the short-landscape
    // tier could never reach its 8rem fallback and a never-dragged operator
    // got the 256px desktop rail in a tier built to prevent exactly that.
    // Leaving the var unset is what lets each tier's own CSS default win,
    // and it keeps those defaults in `rem` so they track --font-size.
    it("writes NO CSS var on cold load, so the CSS default wins", async () => {
      const { applySidebarWidthsFromStorage } = await import("../lib/sidebarWidths");
      applySidebarWidthsFromStorage();
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_LEFT)).toBe("");
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_RIGHT)).toBe("");
    });

    it("writes only the side that has a stored value", async () => {
      localStorage.setItem(STORAGE_KEY_LEFT, "300");
      const { applySidebarWidthsFromStorage } = await import("../lib/sidebarWidths");
      applySidebarWidthsFromStorage();
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_LEFT)).toBe("300px");
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_RIGHT)).toBe("");
    });

    it("writes both CSS vars from stored values", async () => {
      localStorage.setItem(STORAGE_KEY_LEFT, "300");
      localStorage.setItem(STORAGE_KEY_RIGHT, "260");
      const { applySidebarWidthsFromStorage } = await import("../lib/sidebarWidths");
      applySidebarWidthsFromStorage();
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_LEFT)).toBe("300px");
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_RIGHT)).toBe("260px");
    });

    it("applies clamped values when stored exceeds viewport", async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
      localStorage.setItem(STORAGE_KEY_LEFT, "999");
      const { applySidebarWidthsFromStorage } = await import("../lib/sidebarWidths");
      applySidebarWidthsFromStorage();
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_LEFT)).toBe("400px");
    });
  });

  // issue 1827 — the short-landscape tier (#319) used to pin its rails to
  // fixed 8rem/7rem and ignore these vars outright, so the drag handle moved
  // nothing. The rails are draggable in EVERY tier now; what the tier keeps
  // is its own, TIGHTER pair of bounds, so a width chosen on a tall window
  // cannot leak in and starve the centre.
  describe("short-landscape tier bounds", () => {
    it("keeps MIN_WIDTH_PX at 160 — the tier floor is a separate constant", async () => {
      const { MIN_WIDTH_PX, COMPACT_MIN_WIDTH_PX } = await import("../lib/sidebarWidths");
      expect(MIN_WIDTH_PX).toBe(160);
      expect(COMPACT_MIN_WIDTH_PX).toBeLessThan(MIN_WIDTH_PX);
    });

    it("floors at the tier constant, not at the 160px desktop floor", async () => {
      enterShortLandscape(844);
      const { clampWidth, COMPACT_MIN_WIDTH_PX } = await import("../lib/sidebarWidths");
      expect(clampWidth(10)).toBe(COMPACT_MIN_WIDTH_PX);
    });

    it("caps at a quarter of the viewport, so the centre keeps the bulk", async () => {
      enterShortLandscape(844);
      const { clampWidth, maxWidthPx } = await import("../lib/sidebarWidths");
      expect(maxWidthPx()).toBe(211);
      expect(clampWidth(9999)).toBe(211);
      // Both rails at the cap still leave the centre at least half the width.
      expect(844 - 2 * 211).toBeGreaterThanOrEqual(844 / 2);
    });

    it("clamps an already-stored wide value DOWN on entering the tier", async () => {
      // Widened to 400px on a tall window, then the window goes short.
      localStorage.setItem(STORAGE_KEY_LEFT, "400");
      enterShortLandscape(844);
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      expect(getSidebarWidth("left")).toBe(211);
    });

    it("does not rewrite storage when it clamps a read down", async () => {
      localStorage.setItem(STORAGE_KEY_LEFT, "400");
      enterShortLandscape(844);
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      getSidebarWidth("left");
      // Leaving the tier must restore the operator's desktop width.
      expect(localStorage.getItem(STORAGE_KEY_LEFT)).toBe("400");
    });

    it("leaves a usable travel range between the tier floor and cap", async () => {
      enterShortLandscape(844);
      const { maxWidthPx, COMPACT_MIN_WIDTH_PX } = await import("../lib/sidebarWidths");
      expect(maxWidthPx() - COMPACT_MIN_WIDTH_PX).toBeGreaterThan(100);
    });
  });
});
