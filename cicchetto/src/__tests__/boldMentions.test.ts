import { createEffect, createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// issue 2167 — "bold on own-nick mention rows" display preference. Boolean, ON
// by default: the rows render exactly as they do today until a reader opts out.
//
// The bold is genuinely contested — in the same channel one user called it
// annoying and another "comodissimo" — which is the argument for a preference
// rather than flipping the default. vjt's ruling (option A) is that cosmetic
// knobs become first-class validated preferences, NOT a free-form custom CSS
// block: "così sono accessibili a tutti".
//
// ## SHAPE: showBottomBar.ts, not stripFormatting.ts
//
// Both are #449 synced booleans, but this one's default is TRUE, so it takes
// showBottomBar.ts's inverted-default read (`v !== "false"`) rather than
// stripFormatting.ts's `v === "true"`. The difference is not cosmetic: with a
// default of ON, `v === "true"` would read unparseable storage as OFF and ship
// the opt-out to anyone with a corrupted value.
//
// ## POSTURE: synced, on #1766's criterion rather than a coin toss
//
// A per-device toggle is right when the complaint is about a VIEWPORT (#914's
// `hideNextActive`, and fontSize.ts — a screen-size property) and wrong when it
// is about the ACCOUNT. "The bold annoys me" is identical on a phone and on a
// desktop: the account axis. Its nearest neighbour by shape, `strip_formatting`
// (#2029), is synced for that same reason.
//
// ## Why a CSS custom property AND a signal
//
// The property is what actually removes the weight — one write on `<html>`
// restyles every row already in the DOM, with no re-render and no per-row
// class. The signal is for the SettingsDrawer checkbox, which binds to the
// module accessor directly (no drawer-local mirror, same as its two
// neighbours). Neither alone is enough: a bare property write leaves the
// checkbox stale, a bare signal leaves the rows bold.

const STORAGE_KEY = "cicchetto.boldMentions";
const PREF_VAR = "--mention-font-weight";

describe("boldMentions module", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.style.removeProperty(PREF_VAR);
  });

  describe("getBoldMentions()", () => {
    it("defaults to TRUE when localStorage is empty — today's appearance", async () => {
      const { getBoldMentions } = await import("../lib/boldMentions");
      expect(getBoldMentions()).toBe(true);
    });

    it("returns false when localStorage holds 'false'", async () => {
      localStorage.setItem(STORAGE_KEY, "false");
      const { getBoldMentions } = await import("../lib/boldMentions");
      expect(getBoldMentions()).toBe(false);
    });

    it("returns true when localStorage holds 'true'", async () => {
      localStorage.setItem(STORAGE_KEY, "true");
      const { getBoldMentions } = await import("../lib/boldMentions");
      expect(getBoldMentions()).toBe(true);
    });

    // The inverted-default half. stripFormatting.ts can let `v === "true"` do
    // both jobs because its default is OFF; here that shape would read garbage
    // as "opt out", i.e. silently take the bold away from a user who never
    // asked. Pinned because it is the one line the two siblings do differently.
    it("falls back to TRUE when localStorage holds an unparseable value", async () => {
      localStorage.setItem(STORAGE_KEY, "1");
      const { getBoldMentions } = await import("../lib/boldMentions");
      expect(getBoldMentions()).toBe(true);
    });
  });

  describe("setBoldMentions()", () => {
    it("persists 'false' to localStorage when opting out", async () => {
      const { setBoldMentions } = await import("../lib/boldMentions");
      setBoldMentions(false);
      expect(localStorage.getItem(STORAGE_KEY)).toBe("false");
    });

    it("persists 'true' to localStorage when opting back in", async () => {
      const { setBoldMentions } = await import("../lib/boldMentions");
      setBoldMentions(true);
      expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
    });

    // What actually removes the weight from rows ALREADY on screen. Without
    // this write the preference is inert until a reload, and "no reconnect"
    // is half of what the ruling asks for.
    it("writes the CSS custom property so open panes restyle at once", async () => {
      const { setBoldMentions } = await import("../lib/boldMentions");

      setBoldMentions(false);
      expect(document.documentElement.style.getPropertyValue(PREF_VAR)).toBe("normal");

      setBoldMentions(true);
      expect(document.documentElement.style.getPropertyValue(PREF_VAR)).toBe("bold");
    });

    it("re-runs a tracked read, so the settings checkbox follows", async () => {
      const { getBoldMentions, setBoldMentions } = await import("../lib/boldMentions");
      const seen: boolean[] = [];
      createRoot(() => {
        createEffect(() => seen.push(getBoldMentions()));
      });
      await Promise.resolve();
      expect(seen).toEqual([true]);

      setBoldMentions(false);
      await Promise.resolve();
      expect(seen).toEqual([true, false]);

      setBoldMentions(true);
      await Promise.resolve();
      expect(seen).toEqual([true, false, true]);
    });
  });

  describe("applyBoldMentionsFromStorage()", () => {
    // The boot entry, called from main.tsx BEFORE render() so the first frame
    // already carries the reader's choice — the FOUC-free mirror, same job as
    // fontSize.ts's `applyFontSizeFromStorage`.
    it("writes 'normal' at boot when the reader has opted out", async () => {
      localStorage.setItem(STORAGE_KEY, "false");
      const { applyBoldMentionsFromStorage } = await import("../lib/boldMentions");

      applyBoldMentionsFromStorage();

      expect(document.documentElement.style.getPropertyValue(PREF_VAR)).toBe("normal");
    });

    it("writes 'bold' at boot on the default, matching the stylesheet fallback", async () => {
      const { applyBoldMentionsFromStorage } = await import("../lib/boldMentions");

      applyBoldMentionsFromStorage();

      expect(document.documentElement.style.getPropertyValue(PREF_VAR)).toBe("bold");
    });
  });
});
