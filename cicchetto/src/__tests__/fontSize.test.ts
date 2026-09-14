import { beforeEach, describe, expect, it, vi } from "vitest";

// issue 2164 — the module stores a NUMBER now, not one of five keys, so the
// guard that used to be a five-string match is a finiteness check plus a
// clamp. These tests are split along that seam: the ladder (what the presets
// are), the migration (what the old KEYS in a shipped localStorage become),
// the guard (what a poisoned value becomes), and the re-serialisation (what
// actually reaches the CSS property).

const STORAGE_KEY = "cicchetto.fontSize";
const cssVar = () => document.documentElement.style.getPropertyValue("--font-size");

describe("fontSize module", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.style.removeProperty("--font-size");
  });

  describe("the ladder", () => {
    it("carries six presets, XS first at the ruled 11px", async () => {
      const { FONT_SIZE_PRESETS } = await import("../lib/fontSize");
      expect(FONT_SIZE_PRESETS.map((p) => [p.key, p.px])).toEqual([
        ["XS", 11],
        ["S", 12],
        ["M", 14],
        ["L", 16],
        ["XL", 18],
        ["XXL", 20],
      ]);
    });

    it("clamps to the ruled 9–28px range", async () => {
      const { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX } = await import("../lib/fontSize");
      expect(FONT_SIZE_MIN_PX).toBe(9);
      expect(FONT_SIZE_MAX_PX).toBe(28);
    });

    it("brackets every preset inside the clamp range", async () => {
      const { FONT_SIZE_PRESETS, FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX } = await import(
        "../lib/fontSize"
      );
      for (const preset of FONT_SIZE_PRESETS) {
        expect(preset.px).toBeGreaterThanOrEqual(FONT_SIZE_MIN_PX);
        expect(preset.px).toBeLessThanOrEqual(FONT_SIZE_MAX_PX);
      }
    });

    it("falls back to the M preset's px, not a second literal", async () => {
      const { FONT_SIZE_PRESETS, getFontSizePx } = await import("../lib/fontSize");
      const m = FONT_SIZE_PRESETS.find((p) => p.key === "M");
      expect(m).toBeDefined();
      expect(getFontSizePx()).toBe(m?.px);
    });
  });

  describe("migration off the pre-2164 keys", () => {
    // The keys below are what a shipped browser's localStorage holds today,
    // and what two e2e specs still seed (issue962 writes "XXL",
    // issue1228 writes "S"). Read-side mapping, so those keep working.
    it.each([
      ["S", 12],
      ["M", 14],
      ["L", 16],
      ["XL", 18],
      ["XXL", 20],
    ])("maps the stored key %s onto %ipx", async (key, px) => {
      localStorage.setItem(STORAGE_KEY, key);
      const { getFontSizePx } = await import("../lib/fontSize");
      expect(getFontSizePx()).toBe(px);
    });

    it("maps an unknown old value onto M", async () => {
      localStorage.setItem(STORAGE_KEY, "huge");
      const { getFontSizePx } = await import("../lib/fontSize");
      expect(getFontSizePx()).toBe(14);
    });

    it("does not rewrite the stored key on read", async () => {
      // Read-side only: an operator who never touches the control keeps a
      // value an older bundle still understands. The row converts to a
      // number the first time something is actually picked.
      localStorage.setItem(STORAGE_KEY, "S");
      const { getFontSizePx, applyFontSizeFromStorage } = await import("../lib/fontSize");
      getFontSizePx();
      applyFontSizeFromStorage();
      expect(localStorage.getItem(STORAGE_KEY)).toBe("S");
    });
  });

  describe("getFontSizePx() — the stored number", () => {
    it("returns M's 14px when nothing is stored", async () => {
      const { getFontSizePx } = await import("../lib/fontSize");
      expect(getFontSizePx()).toBe(14);
    });

    it("returns a stored in-range number verbatim", async () => {
      localStorage.setItem(STORAGE_KEY, "13");
      const { getFontSizePx } = await import("../lib/fontSize");
      expect(getFontSizePx()).toBe(13);
    });

    // The ruling: out of range is CLAMPED, not silently refused. A negative
    // is out of range, so it lands on the floor rather than on M — the value
    // is a number, it is just not a legal one.
    it.each([
      ["100", 28],
      ["29", 28],
      ["8", 9],
      ["1", 9],
      ["0", 9],
      ["-5", 9],
      ["-1000", 9],
    ])("clamps a stored %s onto %ipx", async (stored, px) => {
      localStorage.setItem(STORAGE_KEY, stored);
      const { getFontSizePx } = await import("../lib/fontSize");
      expect(getFontSizePx()).toBe(px);
    });

    // Not a number at all — there is nothing to clamp, so these fall to M.
    // `""` is in here because `Number("")` is 0, which would otherwise clamp
    // onto the 9px floor and silently shrink the whole app.
    it.each([
      ["NaN"],
      ["Infinity"],
      ["-Infinity"],
      ["1e400"],
      ["14px"],
      ["14px; color: red"],
      ["20px; --evil: 1"],
      [""],
      ["   "],
      ["twelve"],
    ])("falls back to M for the unparseable %j", async (stored) => {
      localStorage.setItem(STORAGE_KEY, stored);
      const { getFontSizePx } = await import("../lib/fontSize");
      expect(getFontSizePx()).toBe(14);
    });
  });

  describe("setFontSizePx() — writes storage + the CSS var, returns what it applied", () => {
    it("writes an in-range number through and echoes it back", async () => {
      const { setFontSizePx } = await import("../lib/fontSize");
      expect(setFontSizePx(11)).toBe(11);
      expect(localStorage.getItem(STORAGE_KEY)).toBe("11");
      expect(cssVar()).toBe("11px");
    });

    it("persists what it applied, not what it was handed", async () => {
      const { setFontSizePx } = await import("../lib/fontSize");
      expect(setFontSizePx(400)).toBe(28);
      expect(localStorage.getItem(STORAGE_KEY)).toBe("28");
      expect(cssVar()).toBe("28px");
    });

    it.each([
      [400, 28],
      [29, 28],
      [8, 9],
      [-5, 9],
      [Number.NaN, 14],
      [Number.POSITIVE_INFINITY, 14],
      [Number.NEGATIVE_INFINITY, 14],
    ])("coerces %j to %ipx", async (input, applied) => {
      const { setFontSizePx } = await import("../lib/fontSize");
      expect(setFontSizePx(input)).toBe(applied);
      expect(cssVar()).toBe(`${applied}px`);
    });

    it("drives every preset onto its px", async () => {
      const { FONT_SIZE_PRESETS, setFontSizePx } = await import("../lib/fontSize");
      for (const preset of FONT_SIZE_PRESETS) {
        setFontSizePx(preset.px);
        expect(cssVar()).toBe(`${preset.px}px`);
      }
    });
  });

  describe("the value that reaches the CSS property is BUILT, never concatenated", () => {
    // The whole point of the guard: `--font-size` is a string this app puts
    // into CSS. Whatever localStorage holds, what comes out is a number this
    // module re-serialised — so a `"20px; --evil: 1"` cannot become two
    // declarations, and nothing lands outside the clamp.
    it.each([
      ["20px; --evil: 1"],
      ["14px"],
      ["-5"],
      ["999999"],
      ["Infinity"],
      [""],
      ["S"],
      ["XXL"],
      ["huge"],
      ["0x20"],
    ])("emits a bare <number>px inside the clamp for %j", async (stored) => {
      localStorage.setItem(STORAGE_KEY, stored);
      const { applyFontSizeFromStorage, FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX } = await import(
        "../lib/fontSize"
      );
      applyFontSizeFromStorage();
      const written = cssVar();
      expect(written).toMatch(/^\d+(\.\d+)?px$/);
      const px = Number(written.slice(0, -2));
      expect(px).toBeGreaterThanOrEqual(FONT_SIZE_MIN_PX);
      expect(px).toBeLessThanOrEqual(FONT_SIZE_MAX_PX);
      expect(document.documentElement.style.getPropertyValue("--evil")).toBe("");
    });
  });

  describe("applyFontSizeFromStorage() — boot-time entry", () => {
    it("applies a stored number on first call", async () => {
      localStorage.setItem(STORAGE_KEY, "11");
      const { applyFontSizeFromStorage } = await import("../lib/fontSize");
      applyFontSizeFromStorage();
      expect(cssVar()).toBe("11px");
    });

    it("applies a migrated legacy key on first call", async () => {
      localStorage.setItem(STORAGE_KEY, "XXL");
      const { applyFontSizeFromStorage } = await import("../lib/fontSize");
      applyFontSizeFromStorage();
      expect(cssVar()).toBe("20px");
    });

    it("falls back to M (14px) when localStorage holds an invalid value", async () => {
      localStorage.setItem(STORAGE_KEY, "bogus");
      const { applyFontSizeFromStorage } = await import("../lib/fontSize");
      applyFontSizeFromStorage();
      expect(cssVar()).toBe("14px");
    });
  });
});
