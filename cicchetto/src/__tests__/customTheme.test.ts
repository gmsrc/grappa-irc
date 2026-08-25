import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setToken } from "../lib/auth";
import {
  activePair,
  applyCachedCustomTheme,
  applyCustomTheme,
  COLOR_KEYS,
  getAppliedThemePayload,
  mountCustomThemeSync,
  resolvePayloadForMode,
  setThemePreviewMode,
  THEME_CSS_VARS,
  tokenToCssVars,
} from "../lib/customTheme";
import { EDITOR_BASE_KEYS, EDITOR_MODE_KEYS, EDITOR_NICK_KEYS } from "../lib/themeEditor";
import type { TokenColors, TokenPayload } from "../lib/themesApi";
import type { ThemesWireT } from "../lib/wireTypes";

// #75 producer path — apply-engine seams the editor depends on.
//
// getAppliedThemePayload() is the editor's snapshot source: the payload
// currently PERSISTED as applied (the localStorage FOUC mirror, written
// on every server-resolved apply). Live preview (`applyCustomTheme`)
// deliberately does NOT touch the cache, so during an editing session
// the cache still holds the pre-edit active theme — exactly what
// cancel/ESC/backdrop must restore.
//
// #1582 — merged with a second file that tested this same module from
// `src/lib/__tests__/`. The two overlapped only on `tokenToCssVars`, and the
// overlap was resolved by the rule that a case may vanish only when it is
// byte-identical to a survivor or strictly weaker than one:
//
//   * the `mono-default` omission was asserted twice with byte-identical
//     bodies — one copy kept, one dropped;
//   * the named-family mapping was asserted twice differing ONLY in
//     strictness, one `toContain('"jetbrains-mono"')` and one
//     `toContain("jetbrains-mono")` — the QUOTED one is kept, because a fold
//     that dropped the CSS quoting would slip past the looser assertion.
//
// Nothing else was dropped, and no surviving case was renamed: the two
// `tokenToCssVars` describes below are deliberately left under their original
// names (the first covers the FONT axis, the second colors + background), so
// that the only case-name difference this consolidation makes is the two
// deletions above and a reviewer can audit that by diffing names alone.
//
// The two files also carried near-identical `payload()` builders seeding
// different colors. They are ONE builder now, on the values the merged-in
// cases assert literally (#111111 / #0000<hex>0); the cases from this side
// only ever assert colors they override, so the unification is inert for them
// and loud if it were not.

const CACHE_KEY = "grappa-custom-theme";

function fullColors(): TokenColors {
  const base = [
    "bg",
    "bg_alt",
    "fg",
    "accent",
    "muted",
    "border",
    "mention",
    "mode_op",
    "mode_halfop",
    "mode_voiced",
    "mode_plain",
  ];
  const colors: Record<string, string> = {};
  for (const k of base) colors[k] = "#111111";
  for (let i = 0; i < 16; i++) colors[`nick_${i}`] = `#0000${(i + 10).toString(16)}0`;
  return colors as TokenColors;
}

function payload(over: Partial<TokenPayload> = {}): TokenPayload {
  return {
    colors: fullColors(),
    font_family: "mono-default",
    background: { image_id: null, builtin: null, size: "cover", opacity: 0.3 },
    ...over,
  };
}

describe("customTheme.getAppliedThemePayload", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when no theme is cached", () => {
    expect(getAppliedThemePayload()).toBeNull();
  });

  it("returns the cached applied payload", () => {
    const p = payload({ colors: { ...fullColors(), bg: "#abcdef" } });
    localStorage.setItem(CACHE_KEY, JSON.stringify(p));
    expect(getAppliedThemePayload()).toEqual(p);
  });

  it("returns null on a malformed cache (never throws)", () => {
    localStorage.setItem(CACHE_KEY, "{not json");
    expect(getAppliedThemePayload()).toBeNull();
  });

  it("returns null on a wrong-shaped cache", () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ nope: true }));
    expect(getAppliedThemePayload()).toBeNull();
  });

  // #358 — the restore snapshot must resolve through the SAME preview override
  // the store apply effect uses, so cancelling an edit while previewing the
  // night slot in daylight restores the night theme, not the day one.
  it("resolves the snapshot through the gallery preview override", () => {
    const dayP = payload({ colors: { ...fullColors(), bg: "#d0d0d0" } });
    const nightP = payload({ colors: { ...fullColors(), bg: "#0d0d0d" } });
    localStorage.setItem(CACHE_KEY, JSON.stringify({ light: dayP, dark: nightP }));
    try {
      setThemePreviewMode("dark");
      expect(getAppliedThemePayload()).toEqual(nightP);
      setThemePreviewMode("light");
      expect(getAppliedThemePayload()).toEqual(dayP);
    } finally {
      setThemePreviewMode(null);
    }
  });
});

// #75 producer path B — font family → --font-mono mapping contract. The
// editor's font picker writes `payload.font_family` (a slug from the closed
// allow-list); the self-hosted @font-face in default.css binds that slug.
describe("customTheme.tokenToCssVars font mapping", () => {
  it("maps a named family to --font-mono with a fallback stack", () => {
    const vars = tokenToCssVars(payload({ font_family: "jetbrains-mono" }));
    expect(vars["--font-mono"]).toContain('"jetbrains-mono"');
    expect(vars["--font-mono"]).toContain("monospace");
  });

  it("omits --font-mono for mono-default so the base stack wins", () => {
    const vars = tokenToCssVars(payload({ font_family: "mono-default" }));
    expect(vars["--font-mono"]).toBeUndefined();
  });

  it("still maps iosevka (no @font-face → graceful fallback via the stack)", () => {
    const vars = tokenToCssVars(payload({ font_family: "iosevka" }));
    expect(vars["--font-mono"]).toContain('"iosevka"');
    expect(vars["--font-mono"]).toContain("monospace");
  });
});

// The other axis of the same pure map: colors and the background layer. The
// font cases live in the describe above — they were written against this
// module from the other location and are kept under the name they had.
describe("tokenToCssVars", () => {
  it("maps color keys to their CSS custom properties", () => {
    const vars = tokenToCssVars(payload());
    expect(vars["--bg"]).toBe("#111111");
    expect(vars["--bg-alt"]).toBe("#111111");
    expect(vars["--mode-op"]).toBe("#111111");
    expect(vars["--mode-halfop"]).toBe("#111111");
    expect(vars["--nick-color-0"]).toBe("#0000a0");
    expect(vars["--nick-color-15"]).toBe("#0000190");
  });

  it("background with no image maps to none + the opacity var", () => {
    const vars = tokenToCssVars(
      payload({ background: { image_id: null, builtin: null, size: "cover", opacity: 0.3 } }),
    );
    expect(vars["--theme-bg-image"]).toBe("none");
    expect(vars["--theme-bg-opacity"]).toBe("0.3");
  });

  it("background with a slug maps to a /uploads url()", () => {
    const vars = tokenToCssVars(
      payload({ background: { image_id: "abc123", builtin: null, size: "cover", opacity: 0.5 } }),
    );
    expect(vars["--theme-bg-image"]).toBe('url("/uploads/abc123")');
    expect(vars["--theme-bg-opacity"]).toBe("0.5");
  });

  // #294 — a built-in key resolves to the static /backgrounds/<key>.webp asset
  // (the BuiltinBackgrounds.path convention); it takes precedence over image_id.
  it("a builtin key maps to a /backgrounds url()", () => {
    const vars = tokenToCssVars(
      payload({
        background: { image_id: null, builtin: "01-lain-dark", size: "cover", opacity: 0.4 },
      }),
    );
    expect(vars["--theme-bg-image"]).toBe('url("/backgrounds/01-lain-dark.webp")');
    expect(vars["--theme-bg-opacity"]).toBe("0.4");
  });

  it("size cover maps the sizing vars to cover + no-repeat", () => {
    const vars = tokenToCssVars(
      payload({
        background: { image_id: null, builtin: "01-lain-dark", size: "cover", opacity: 0.3 },
      }),
    );
    expect(vars["--theme-bg-size"]).toBe("cover");
    expect(vars["--theme-bg-repeat"]).toBe("no-repeat");
  });

  it("size repeat maps the sizing vars to auto + repeat (forward-compat tile mode)", () => {
    const vars = tokenToCssVars(
      payload({
        background: { image_id: null, builtin: "01-lain-dark", size: "repeat", opacity: 0.3 },
      }),
    );
    expect(vars["--theme-bg-size"]).toBe("auto");
    expect(vars["--theme-bg-repeat"]).toBe("repeat");
  });

  it("a pre-#294 payload (no builtin/size) degrades to the upload path + cover", () => {
    const legacy = payload();
    // An old cached / wire payload lacking the new fields (a theme row saved
    // before #294, returned as-is by the server until re-saved).
    legacy.background = { image_id: "abc123", opacity: 0.3 } as TokenPayload["background"];
    const vars = tokenToCssVars(legacy);
    expect(vars["--theme-bg-image"]).toBe('url("/uploads/abc123")');
    expect(vars["--theme-bg-size"]).toBe("cover");
    expect(vars["--theme-bg-repeat"]).toBe("no-repeat");
  });
});

// #75 producer path C — the background wallpaper layer is CSS-gated on a
// `theme-has-bg` class (default.css can't branch on a var being "none").
// applyCustomTheme toggles it so the layer + pane translucency only engage
// when a theme actually carries a background image.
describe("customTheme.applyCustomTheme background class", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.documentElement.style.cssText = "";
  });

  it("adds theme-has-bg when a background image is set", () => {
    applyCustomTheme(
      payload({ background: { image_id: "abcdef", builtin: null, size: "cover", opacity: 0.3 } }),
    );
    expect(document.documentElement.classList.contains("theme-has-bg")).toBe(true);
  });

  it("adds theme-has-bg when a built-in background is selected", () => {
    applyCustomTheme(
      payload({
        background: { image_id: null, builtin: "01-lain-dark", size: "cover", opacity: 0.3 },
      }),
    );
    expect(document.documentElement.classList.contains("theme-has-bg")).toBe(true);
  });

  it("removes theme-has-bg when the background image is cleared", () => {
    applyCustomTheme(
      payload({ background: { image_id: "abcdef", builtin: null, size: "cover", opacity: 0.3 } }),
    );
    applyCustomTheme(
      payload({ background: { image_id: null, builtin: null, size: "cover", opacity: 0.3 } }),
    );
    expect(document.documentElement.classList.contains("theme-has-bg")).toBe(false);
  });

  it("removes theme-has-bg on a null apply (clear back to base)", () => {
    applyCustomTheme(
      payload({ background: { image_id: "abcdef", builtin: null, size: "cover", opacity: 0.3 } }),
    );
    applyCustomTheme(null);
    expect(document.documentElement.classList.contains("theme-has-bg")).toBe(false);
  });
});

describe("applyCustomTheme", () => {
  const root = () => document.documentElement;

  beforeEach(() => {
    for (const v of THEME_CSS_VARS) root().style.removeProperty(v);
  });
  afterEach(() => {
    for (const v of THEME_CSS_VARS) root().style.removeProperty(v);
  });

  it("writes the token vars onto documentElement", () => {
    applyCustomTheme(payload({ font_family: "jetbrains-mono" }));
    expect(root().style.getPropertyValue("--bg")).toBe("#111111");
    expect(root().style.getPropertyValue("--nick-color-3")).toBe("#0000d0");
    expect(root().style.getPropertyValue("--font-mono")).toContain("jetbrains-mono");
  });

  it("null clears every theme var back to the base cascade", () => {
    applyCustomTheme(payload());
    expect(root().style.getPropertyValue("--bg")).toBe("#111111");
    applyCustomTheme(null);
    expect(root().style.getPropertyValue("--bg")).toBe("");
    expect(root().style.getPropertyValue("--nick-color-0")).toBe("");
    expect(root().style.getPropertyValue("--theme-bg-image")).toBe("");
  });
});

describe("applyCachedCustomTheme boot guard", () => {
  const root = () => document.documentElement;

  beforeEach(() => {
    for (const v of THEME_CSS_VARS) root().style.removeProperty(v);
    localStorage.removeItem(CACHE_KEY);
  });
  afterEach(() => {
    for (const v of THEME_CSS_VARS) root().style.removeProperty(v);
    localStorage.removeItem(CACHE_KEY);
  });

  it("a malformed cached payload does not throw and applies nothing", () => {
    // Valid JSON but wrong shape (no colors/background) — reaches the apply
    // engine at module top-level BEFORE render, outside any ErrorBoundary,
    // so a throw here would white-screen the PWA on every boot.
    localStorage.setItem(CACHE_KEY, JSON.stringify({ foo: 1 }));
    expect(() => applyCachedCustomTheme()).not.toThrow();
    expect(root().style.getPropertyValue("--bg")).toBe("");
  });

  it("a non-JSON cache does not throw", () => {
    localStorage.setItem(CACHE_KEY, "not json{{");
    expect(() => applyCachedCustomTheme()).not.toThrow();
  });

  it("a well-formed cached payload applies", () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload()));
    applyCachedCustomTheme();
    expect(root().style.getPropertyValue("--bg")).toBe("#111111");
  });
});

// #358 — day/night pair resolution. `resolvePayloadForMode` is the re-apply
// DECISION (which slot paints for a given mode); the live wiring that flips
// `dark` on an OS change is proven in theme.test.ts (`prefersDark` updates)
// and end-to-end in the Playwright emulateMedia spec. The boot path applies
// the resolved slot for the CURRENT mode with no FOUC.
describe("resolvePayloadForMode (#358 day/night resolution)", () => {
  const day = payload();
  const night = payload();

  it("light mode paints the light (day) slot", () => {
    expect(resolvePayloadForMode({ light: day, dark: night }, false)).toBe(day);
  });

  it("dark mode paints the dark (night) slot", () => {
    expect(resolvePayloadForMode({ light: day, dark: night }, true)).toBe(night);
  });

  it("dark mode falls back to the light slot when unpaired (single pick)", () => {
    expect(resolvePayloadForMode({ light: day, dark: null }, true)).toBe(day);
  });

  it("an empty pair resolves to null in both modes", () => {
    expect(resolvePayloadForMode({ light: null, dark: null }, true)).toBeNull();
    expect(resolvePayloadForMode({ light: null, dark: null }, false)).toBeNull();
  });
});

describe("applyCachedCustomTheme day/night pair boot (#358)", () => {
  const root = () => document.documentElement;
  // Captured before the first override: `bootWith` REPLACES window.matchMedia
  // outright (a plain assignment, so `vi.restoreAllMocks` cannot undo it).
  // In its own file that leaked no further than the file; sharing a file with
  // the #837 mount cases below makes restoring it load-bearing rather than
  // tidy — those read the real one.
  const realMatchMedia = window.matchMedia;

  function payloadBg(bg: string): TokenPayload {
    const p = payload();
    return { ...p, colors: { ...p.colors, bg } };
  }

  // Boot a FRESH customTheme module with matchMedia reporting `dark`, so the
  // OS-mode read at boot resolves to the right slot. resetModules re-imports
  // theme.ts too, which reads this mock to seed `prefersDark`.
  async function bootWith(dark: boolean, cache: unknown): Promise<void> {
    for (const v of THEME_CSS_VARS) root().style.removeProperty(v);
    vi.resetModules();
    window.matchMedia = vi.fn().mockImplementation((media: string) => ({
      media,
      matches: media.includes("dark") ? dark : false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    const mod = await import("../lib/customTheme");
    mod.applyCachedCustomTheme();
  }

  afterEach(() => {
    window.matchMedia = realMatchMedia;
    for (const v of THEME_CSS_VARS) root().style.removeProperty(v);
    localStorage.removeItem(CACHE_KEY);
  });

  it("dark OS mode paints the dark slot's --bg", async () => {
    await bootWith(true, { light: payloadBg("#d1d1d1"), dark: payloadBg("#0a0a0a") });
    expect(root().style.getPropertyValue("--bg")).toBe("#0a0a0a");
  });

  it("light OS mode paints the light slot's --bg", async () => {
    await bootWith(false, { light: payloadBg("#d1d1d1"), dark: payloadBg("#0a0a0a") });
    expect(root().style.getPropertyValue("--bg")).toBe("#d1d1d1");
  });

  it("dark OS mode with an unpaired cache falls back to the light slot", async () => {
    await bootWith(true, { light: payloadBg("#d1d1d1"), dark: null });
    expect(root().style.getPropertyValue("--bg")).toBe("#d1d1d1");
  });

  it("a legacy #75 bare-payload cache applies in both modes (backward-compat)", async () => {
    await bootWith(true, payloadBg("#cafe00"));
    expect(root().style.getPropertyValue("--bg")).toBe("#cafe00");
  });
});

// #75 producer path — the editor renders a color picker per grouped key.
// If a key existed in the canonical set but no editor group, it would be a
// silently NON-editable token (preserved on save via the cloned seed, but
// with no control). Pin the grouped vocabulary against COLOR_KEYS.
describe("editor color vocabulary vs the canonical key set", () => {
  it("the grouped editor keys exactly cover customTheme.COLOR_KEYS", () => {
    const editorKeys = new Set<string>([
      ...EDITOR_BASE_KEYS,
      ...EDITOR_MODE_KEYS,
      ...EDITOR_NICK_KEYS,
    ]);
    expect(editorKeys).toEqual(new Set<string>(COLOR_KEYS));
  });
});

// #837 — the mid-flight identity guard in `mountCustomThemeSync`, which had no
// test at all: the effect captured `token()` at entry, awaited GET /me/theme,
// and re-checked before applying. Removing that re-check broke nothing, so the
// rule was free to be dropped by anyone tidying the module.
//
// What it holds: `applyResolvedPair` is not a read — it paints documentElement
// AND writes the boot cache. A response that lands after a rotation therefore
// puts subject A's theme on subject B's screen and persists it as B's
// FOUC-free boot theme, so it survives the reload that would otherwise correct
// it. Identity-transition cleanup cannot reach this: A→B never runs the
// logout-clear branch, and nothing cancels a request already on the wire.
describe("mountCustomThemeSync — a response that outlives its identity (#837)", () => {
  const A_TOKEN = "tok-a";
  const B_TOKEN = "tok-b";
  const A_BG = "#aa0000";
  const B_BG = "#00bb00";

  const themed = (bg: string): TokenPayload => {
    const base = payload();
    return { ...base, colors: { ...base.colors, bg } as TokenColors };
  };

  const themeRow = (id: number, bg: string): ThemesWireT => ({
    id,
    name: `theme-${id}`,
    author: "tester",
    built_in: false,
    published: true,
    apply_count: 0,
    in_use: 0,
    mine: true,
    payload: themed(bg) as unknown as Record<string, unknown>,
    inserted_at: "2026-01-01T00:00:00Z",
  });

  const bearerOf = (init?: RequestInit): string | null =>
    new Headers(init?.headers).get("authorization");

  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  // Hold A's GET open; answer any other bearer with B's theme immediately, so
  // the only route by which A's theme can reach the DOM or the cache is the
  // held continuation under test.
  function stubWithHeldGetForA(): { release: (pair: unknown) => void } {
    let release!: (r: Response) => void;
    const held = new Promise<Response>((r) => {
      release = r;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init?: RequestInit) => {
      if (bearerOf(init) === `Bearer ${A_TOKEN}`) return held;
      return Promise.resolve(
        new Response(JSON.stringify({ light: themeRow(2, B_BG), dark: null }), { status: 200 }),
      );
    });
    return {
      release: (pair: unknown) => release(new Response(JSON.stringify(pair), { status: 200 })),
    };
  }

  // Disposal in afterEach, not at the end of each case: the effect under test
  // writes module-singleton state, so a case that fails an assertion and skips
  // its own dispose() would leave a live sync running against the NEXT case's
  // fetch stub — the failure would then cascade into a neighbour that is fine.
  let dispose: (() => void) | null = null;

  function mountFor(t: string): void {
    setToken(t);
    createRoot((d) => {
      dispose = d;
      mountCustomThemeSync();
    });
  }

  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it("does not paint or cache the previous subject's theme when its GET lands after a rotation", async () => {
    const a = stubWithHeldGetForA();
    mountFor(A_TOKEN);
    await flush(); // A's GET is on the wire, held

    setToken(B_TOKEN); // rotation lands INSIDE A's await; B's own theme applies
    await flush();

    a.release({ light: themeRow(1, A_BG), dark: null });
    await flush();

    expect(activePair()).toEqual({ light: 2, dark: null });
    expect(getAppliedThemePayload()?.colors.bg).toBe(B_BG);
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe(B_BG);
  });

  // The control. Same harness, same held response, no rotation: without it a
  // gate that never delivered A's pair would make the case above pass while
  // asserting nothing.
  it("does apply that same response when the identity holds", async () => {
    const a = stubWithHeldGetForA();
    mountFor(A_TOKEN);
    await flush();

    a.release({ light: themeRow(1, A_BG), dark: null });
    await flush();

    expect(activePair()).toEqual({ light: 1, dark: null });
    expect(getAppliedThemePayload()?.colors.bg).toBe(A_BG);
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe(A_BG);
  });
});
