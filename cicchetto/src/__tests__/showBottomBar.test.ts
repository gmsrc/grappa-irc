import { createEffect, createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #1766 — "show the mobile window bar" display preference. Boolean, ON by
// default: the BottomBar becomes opt-OUT, never deleted (#174's standing
// constraint, and #71's second ruling reversed "kill the mobile bottom bar").
//
// It takes colorNicklist.ts's SHAPE (module-singleton signal + localStorage
// write-through) because the flag is read at RENDER time by Shell's <Show>
// around <BottomBar />, and its POSTURE (one of the #449 server-backed prefs,
// PUT by `displayPrefs.ts`) because the complaint behind it — "7 networks" —
// is account-scoped, not viewport-scoped like #914's per-device sibling.
//
// The default is the interesting half. Every sibling flag defaults OFF, so
// `v === "true"` happens to mean both "parse the stored value" and "fall back
// to the default on garbage". Inverting the default breaks that coincidence:
// the fallback has to be spelled out, and the tests below are what say which
// side unparseable storage lands on.

describe("showBottomBar module", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  describe("getShowBottomBar()", () => {
    it("defaults to TRUE when localStorage is empty — the bar ships shown", async () => {
      const { getShowBottomBar } = await import("../lib/showBottomBar");
      expect(getShowBottomBar()).toBe(true);
    });

    it("returns false when localStorage holds 'false'", async () => {
      localStorage.setItem("cicchetto.showBottomBar", "false");
      const { getShowBottomBar } = await import("../lib/showBottomBar");
      expect(getShowBottomBar()).toBe(false);
    });

    it("returns true when localStorage holds 'true'", async () => {
      localStorage.setItem("cicchetto.showBottomBar", "true");
      const { getShowBottomBar } = await import("../lib/showBottomBar");
      expect(getShowBottomBar()).toBe(true);
    });

    // The one that pins the inverted default. A copy-paste of colorNicklist's
    // `v === "true"` reads garbage as FALSE, i.e. it takes the primary mobile
    // navigation away over a corrupted key — the opposite of the safe side.
    it("falls back to TRUE when localStorage holds an unparseable value", async () => {
      localStorage.setItem("cicchetto.showBottomBar", "1");
      const { getShowBottomBar } = await import("../lib/showBottomBar");
      expect(getShowBottomBar()).toBe(true);
    });
  });

  describe("setShowBottomBar()", () => {
    it("persists 'false' to localStorage when hidden", async () => {
      const { setShowBottomBar } = await import("../lib/showBottomBar");
      setShowBottomBar(false);
      expect(localStorage.getItem("cicchetto.showBottomBar")).toBe("false");
    });

    it("persists 'true' to localStorage when shown", async () => {
      const { setShowBottomBar } = await import("../lib/showBottomBar");
      setShowBottomBar(true);
      expect(localStorage.getItem("cicchetto.showBottomBar")).toBe("true");
    });

    // The assertion that constrains the SHAPE. A plain `localStorage.getItem`
    // getter passes every test above — including a set-then-get round trip —
    // while leaving Shell's mounted <Show> gate stale until a reload. Only a
    // TRACKED read proves the signal: the effect must re-run.
    it("re-runs a tracked read, so the mounted gate re-renders on toggle", async () => {
      const { getShowBottomBar, setShowBottomBar } = await import("../lib/showBottomBar");
      const seen: boolean[] = [];
      createRoot(() => {
        createEffect(() => seen.push(getShowBottomBar()));
      });
      await Promise.resolve();
      expect(seen).toEqual([true]);

      setShowBottomBar(false);
      await Promise.resolve();
      expect(seen).toEqual([true, false]);
    });
  });
});
