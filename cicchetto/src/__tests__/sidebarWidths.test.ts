import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirror-shape of fontSize.test.ts. Imports are dynamic so each `beforeEach`
// can reset localStorage + the CSS vars and re-import the module fresh.

const STORAGE_KEY_LEFT = "cicchetto.sidebarWidth";
const STORAGE_KEY_RIGHT = "cicchetto.membersWidth";
const CSS_VAR_LEFT = "--sidebar-width";
const CSS_VAR_RIGHT = "--members-width";

// issue 2165 — the desktop floor is a `rem` quantity now, so every assertion
// about it has to declare the basis it is measured at. Production gets that
// basis from `html { font-size: var(--font-size) }` in themes/default.css;
// jsdom loads no stylesheet AND does not substitute `var()` — measured:
// setting `--font-size: 9px` on <html> leaves `getComputedStyle(html)
// .fontSize` at jsdom's own 16px default, while an inline `style.fontSize`
// reads straight back. So the inline property is how a test states "the root
// font size is N", and 16 is what the module would otherwise see here — which
// is NOT the app's 14px default and would quietly shift every number below.
function setRootFontSize(px: number): void {
  document.documentElement.style.fontSize = `${px}px`;
}

// The full range --font-size can take. S…XXL is the shipped ladder; 9 and 28
// are the bounds of the custom field, so a floor derived from the root font
// size has to stay sane across all of it.
const FONT_SIZE_RANGE_PX = [9, 11, 12, 14, 16, 18, 20, 22, 28];

// The narrowest viewport that still renders THIS shell: below 769px the
// #319/#1827 tier predicate and Shell.tsx hand over to `.shell-mobile`.
const NARROWEST_DESKTOP_PX = 769;

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
    // Every pre-2165 expectation in this file was written against the 160px
    // floor, which is what the rem floor resolves to at the app's default
    // font size. Pin that basis so those numbers keep meaning what they said.
    setRootFontSize(14);
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

    it("clamps stored value below the floor (160 at the default font) up to it", async () => {
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
      const { clampWidth, minWidthPx } = await import("../lib/sidebarWidths");
      expect(clampWidth(0)).toBe(minWidthPx());
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
    it("keeps the desktop floor at 160 at the default font — separate constants", async () => {
      const { minWidthPx, COMPACT_MIN_WIDTH_PX } = await import("../lib/sidebarWidths");
      expect(minWidthPx()).toBe(160);
      expect(COMPACT_MIN_WIDTH_PX).toBeLessThan(minWidthPx());
    });

    // issue 2165's second question. The tier floor stays px while its desktop
    // sibling goes rem, so the two could in principle cross and leave this
    // constant unreachable. They do not, anywhere the app can be driven.
    it("stays the LOWER floor across the whole font range — not dead code", async () => {
      const { minWidthPx, COMPACT_MIN_WIDTH_PX } = await import("../lib/sidebarWidths");
      for (const px of FONT_SIZE_RANGE_PX) {
        setRootFontSize(px);
        expect(COMPACT_MIN_WIDTH_PX).toBeLessThan(minWidthPx());
      }
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

  // issue 2165 — the reported defect: the members rail stopped shrinking well
  // before the nicks needed the room, and the leftover empty band GREW as the
  // operator shrank the font, because the floor was 160 flat px while every
  // width around it was in `rem`.
  describe("desktop floor tracks the root font size", () => {
    // The two guard-arm cases below stub getComputedStyle, and the stub must
    // not outlive them. It goes in afterEach and NOT in the file's beforeEach:
    // setupTests.ts installs a fresh in-memory localStorage from its OWN
    // beforeEach, which runs FIRST, so an unstub from here would strip that
    // mock one step after it was installed and hand the module the real
    // Storage, still carrying the previous test's widths. Measured, and
    // setupTests.ts's header warns about exactly this: two unrelated
    // applySidebarWidthsFromStorage cases went red reading a leaked 281px.
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // The anchor, from below. 160/14 is the only conversion that leaves the
    // shipped floor untouched at the default font size; the natural-looking
    // 10rem is the conversion for a 16px root, which this app does not have,
    // and it would silently narrow every desktop rail by 20px on merge.
    it("is still exactly the 160px that shipped, at the default font size", async () => {
      const { minWidthPx } = await import("../lib/sidebarWidths");
      setRootFontSize(14);
      expect(minWidthPx()).toBe(160);
    });

    // The defect itself. A constant floor answers the same number at every
    // rung — this is the assertion the pre-2165 module cannot satisfy.
    it("answers a strictly smaller floor at every smaller font size", async () => {
      const { minWidthPx } = await import("../lib/sidebarWidths");
      let previous = 0;
      for (const px of FONT_SIZE_RANGE_PX) {
        setRootFontSize(px);
        const floor = minWidthPx();
        expect(floor).toBeGreaterThan(previous);
        previous = floor;
      }
    });

    // Linearity + anchor in one statement, without restating MIN_WIDTH_REM:
    // scale any rung's floor back to the default font and the shipped 160 has
    // to come out. Tolerance is the ±0.5px rounding, widened by the scale.
    it("is proportional to the font size, anchored on the shipped 160", async () => {
      const { minWidthPx } = await import("../lib/sidebarWidths");
      for (const px of FONT_SIZE_RANGE_PX) {
        setRootFontSize(px);
        expect(Math.abs((minWidthPx() * 14) / px - 160)).toBeLessThanOrEqual(1);
      }
    });

    // The anchor, from above — and the property a rem floor could plausibly
    // break where a px one could not. `maxWidthPx` clamps ITSELF up to the
    // floor, so a floor that outgrows half the viewport does not error: it
    // silently collapses min onto max and the handle stops moving. On the
    // narrowest shell that still renders rails, at the largest font the app
    // can be put in, there must still be travel.
    it("leaves the handle somewhere to travel, at every font size", async () => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: NARROWEST_DESKTOP_PX,
      });
      const { maxWidthPx, minWidthPx } = await import("../lib/sidebarWidths");
      for (const px of FONT_SIZE_RANGE_PX) {
        setRootFontSize(px);
        expect(maxWidthPx()).toBeGreaterThan(minWidthPx());
      }
    });

    // End to end, in the units of the complaint: at the smallest font the
    // rail can finally follow short nicks down past where 160px used to stop
    // it. No nick is truncated by any of this — the floor is a lower bound on
    // the drag, not a width imposed on the list.
    it("accepts a width the 160px constant used to refuse", async () => {
      const { clampWidth } = await import("../lib/sidebarWidths");
      setRootFontSize(9);
      expect(clampWidth(110)).toBe(110);
    });

    // Both arms of the module's read guard, so neither is untested defensive
    // code. Same posture as inShortLandscape()'s absent-matchMedia arm: an
    // environment that cannot answer gets the stylesheet default, never a
    // guess and never a crash.
    it("falls back to the stylesheet default where getComputedStyle is absent", async () => {
      vi.stubGlobal("getComputedStyle", undefined);
      const { minWidthPx } = await import("../lib/sidebarWidths");
      setRootFontSize(9);
      expect(minWidthPx()).toBe(160);
    });

    // A zero root font size would otherwise multiply the floor to 0, and a
    // zero floor is not a narrow rail — it is a rail the operator can drag
    // shut with no handle left to drag it back.
    it("falls back rather than collapsing the floor on a zero font size", async () => {
      vi.stubGlobal("getComputedStyle", () => ({ fontSize: "0px" }) as CSSStyleDeclaration);
      const { clampWidth, minWidthPx } = await import("../lib/sidebarWidths");
      expect(minWidthPx()).toBe(160);
      expect(clampWidth(1)).toBe(160);
    });

    // The coupling the whole conversion rests on. `rem` resolves against the
    // ROOT font size, and it equals --font-size only because default.css says
    // so. Delete that declaration and the floor silently detaches from the
    // ladder with nothing else going red.
    it("is coupled to default.css giving html font-size: var(--font-size)", () => {
      const css = readFileSync("src/themes/default.css", "utf8");
      expect(css).toMatch(/html,\s*body\s*\{[^}]*font-size:\s*var\(--font-size\)/);
    });
  });
});
