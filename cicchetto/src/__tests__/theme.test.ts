import { beforeEach, describe, expect, it, vi } from "vitest";

describe("theme module", () => {
  beforeEach(() => {
    vi.resetModules();
    document.documentElement.removeAttribute("data-theme");
  });

  // #299 — the user-facing auto/mirc/irssi selector (getTheme/setTheme) was
  // removed; the base look is now always OS-resolved at boot. A gallery theme
  // (#75) layers inline CSS vars over this base.
  describe("applyTheme() — boot-time base", () => {
    it("resolves the OS dark preference to irssi-dark", async () => {
      window.matchMedia = vi.fn().mockReturnValue({
        matches: true,
        media: "(prefers-color-scheme: dark)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as typeof window.matchMedia;

      const theme = await import("../lib/theme");
      theme.applyTheme();
      expect(document.documentElement.dataset.theme).toBe("irssi-dark");
    });

    it("resolves a non-dark OS preference to mirc-light", async () => {
      window.matchMedia = vi.fn().mockReturnValue({
        matches: false,
        media: "(prefers-color-scheme: dark)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as typeof window.matchMedia;

      const theme = await import("../lib/theme");
      theme.applyTheme();
      expect(document.documentElement.dataset.theme).toBe("mirc-light");
    });

    it("wires an OS-preference change listener at boot", async () => {
      const addEventListener = vi.fn();
      window.matchMedia = vi.fn().mockReturnValue({
        matches: false,
        media: "(prefers-color-scheme: dark)",
        addEventListener,
        removeEventListener: vi.fn(),
      }) as unknown as typeof window.matchMedia;

      const theme = await import("../lib/theme");
      theme.applyTheme();
      // A "change" listener is attached so OS-level dark/light flips
      // re-resolve the base live (no user toggle since #299).
      expect(addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    });
  });

  describe("isMobile() — reactive signal", () => {
    it("is false when viewport > 768px (jsdom default)", async () => {
      // jsdom's matchMedia mock returns matches: false unless explicitly
      // configured — we'll mock it.
      const matchMediaMock = vi.fn().mockReturnValue({
        matches: false,
        media: "(max-width: 768px)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      window.matchMedia = matchMediaMock as unknown as typeof window.matchMedia;

      const theme = await import("../lib/theme");
      expect(theme.isMobile()).toBe(false);
    });
  });

  // #358 — the reactive OS dark-mode preference the gallery day/night layer
  // subscribes to. Per-query mock so the dark query drives prefersDark while
  // the mobile query stays independent.
  describe("prefersDark() — reactive OS color-scheme signal", () => {
    function mockMatchMedia(darkMatches: boolean): (m: string) => Record<string, unknown> {
      const registries = new Map<string, ((e: { matches: boolean }) => void)[]>();
      const factory = (media: string) => ({
        media,
        matches: media.includes("dark") ? darkMatches : false,
        addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
          const list = registries.get(media) ?? [];
          list.push(cb);
          registries.set(media, list);
        },
        removeEventListener: vi.fn(),
        // Test helper: fire the captured "change" listeners for this query.
        __fire: (matches: boolean) => {
          for (const cb of registries.get(media) ?? []) cb({ matches });
        },
      });
      const cache = new Map<string, Record<string, unknown>>();
      const memo = (media: string) => {
        const hit = cache.get(media);
        if (hit) return hit;
        const made = factory(media);
        cache.set(media, made);
        return made;
      };
      window.matchMedia = ((media: string) => memo(media)) as unknown as typeof window.matchMedia;
      return memo;
    }

    it("initialises from the dark media query at import", async () => {
      mockMatchMedia(true);
      const theme = await import("../lib/theme");
      expect(theme.prefersDark()).toBe(true);
    });

    it("initialises false when the OS is in light mode", async () => {
      mockMatchMedia(false);
      const theme = await import("../lib/theme");
      expect(theme.prefersDark()).toBe(false);
    });

    it("updates live when the OS flips dark (change listener fires)", async () => {
      const memo = mockMatchMedia(false);
      const theme = await import("../lib/theme");
      expect(theme.prefersDark()).toBe(false);
      (memo("(prefers-color-scheme: dark)").__fire as (m: boolean) => void)(true);
      expect(theme.prefersDark()).toBe(true);
    });
  });
});
