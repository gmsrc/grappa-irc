import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSmartScrollPin,
  installViewportHeightTracker,
  type ResumeDocumentLike,
  type ResumeWindowLike,
  type VisualViewportLike,
} from "../lib/viewportHeight";

// UX-6 D9 — single helper, two CSS vars (--viewport-height legacy +
// --vh Telegram pattern). Unit coverage proves both vars write on
// boot AND on every resize event. Real keyboard behaviour is verified
// by vjt on iPhone (Playwright doesn't emulate the OS keyboard);
// these tests are the mechanical contract.
//
// #649/#654 — the resume triggers (visibilitychange / pageshow / focus)
// are wiring, and wiring IS desktop-provable: each trigger must reach the
// ONE writer and re-run the ONE settle schedule, with no resize event in
// play. What is NOT provable here is the user-visible iOS behaviour (the
// app-switch-return half-height itself) — that is vjt's device leg. These
// tests assert the mechanical contract only, deliberately.

function makeFakeVp(initialHeight: number): {
  vp: VisualViewportLike;
  fireResize: (h: number) => void;
  setHeight: (h: number) => void;
} {
  let handler: (() => void) | null = null;
  let height = initialHeight;
  const vp: VisualViewportLike = {
    get height() {
      return height;
    },
    addEventListener(event, h) {
      if (event === "resize") handler = h;
    },
  } as VisualViewportLike;
  return {
    vp,
    fireResize: (h: number) => {
      height = h;
      handler?.();
    },
    // Change the reported height WITHOUT dispatching a resize event — the
    // #285-reopen "silent settle" an installed iOS PWA emits no `resize` for.
    setHeight: (h: number) => {
      height = h;
    },
  };
}

// #649 resume-trigger host. Fakes the window + document seams so a test can
// fire a resume WITHOUT touching the real jsdom window — the module has no
// uninstall path, so a real-window listener would outlive its test and keep a
// stale `vp` closure alive for every later test in the file.
function makeResumeHost(): {
  win: ResumeWindowLike;
  doc: ResumeDocumentLike;
  setVisibility: (state: DocumentVisibilityState) => void;
  firePageShow: () => void;
  fireFocus: () => void;
  fireVisibilityChange: () => void;
  vvListenerEvents: () => string[];
} {
  const winHandlers = new Map<string, () => void>();
  const docHandlers = new Map<string, () => void>();
  let visibilityState: DocumentVisibilityState = "visible";
  return {
    win: {
      addEventListener(event, h) {
        winHandlers.set(event, h);
      },
    },
    doc: {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener(event, h) {
        docHandlers.set(event, h);
      },
    },
    setVisibility: (state: DocumentVisibilityState) => {
      visibilityState = state;
    },
    firePageShow: () => winHandlers.get("pageshow")?.(),
    fireFocus: () => winHandlers.get("focus")?.(),
    fireVisibilityChange: () => docHandlers.get("visibilitychange")?.(),
    vvListenerEvents: () => [...winHandlers.keys(), ...docHandlers.keys()],
  };
}

describe("viewportHeight module", () => {
  beforeEach(() => {
    // Fake timers so the boot settle re-read schedule (#285 reopen) never
    // leaks a deferred CSS-var write across tests; tests that don't advance
    // are unaffected (the synchronous boot write happens before any timer).
    vi.useFakeTimers();
    document.documentElement.style.removeProperty("--viewport-height");
    document.documentElement.style.removeProperty("--vh");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes --viewport-height (px) on boot", () => {
    const { vp } = makeFakeVp(852);
    const host = makeResumeHost();
    installViewportHeightTracker(vp, host.win, host.doc);
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("852px");
  });

  it("writes --vh (px, height * 0.01) on boot — Telegram pattern", () => {
    const { vp } = makeFakeVp(852);
    const host = makeResumeHost();
    installViewportHeightTracker(vp, host.win, host.doc);
    // 852 * 0.01 = 8.52
    expect(document.documentElement.style.getPropertyValue("--vh")).toBe("8.52px");
  });

  it("updates both vars on every resize event", () => {
    const { vp, fireResize } = makeFakeVp(852);
    const host = makeResumeHost();
    installViewportHeightTracker(vp, host.win, host.doc);
    fireResize(620); // keyboard opens — viewport shrinks
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("620px");
    expect(document.documentElement.style.getPropertyValue("--vh")).toBe("6.20px");
    fireResize(852); // keyboard dismisses — viewport restores
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("852px");
    expect(document.documentElement.style.getPropertyValue("--vh")).toBe("8.52px");
  });

  it("is a no-op when the viewport argument is undefined", () => {
    const host = makeResumeHost();
    installViewportHeightTracker(undefined, host.win, host.doc);
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--vh")).toBe("");
    // No viewport to read → no resume listeners either (nothing to re-read).
    expect(host.vvListenerEvents()).toEqual([]);
  });

  it("re-reads the settled viewport height on a post-boot timer, WITHOUT a resize event (#285 reopen)", () => {
    // The reported P0 mechanism: on a cold iOS-PWA kill+relaunch the boot read
    // latches an INFLATED height (pre-settle), and the corrective settle fires
    // NO `resize` event — so the one-shot boot write is never re-read and the
    // scroll container bakes to the inflated height forever. The reopen fix
    // re-reads visualViewport.height on a short post-boot timer schedule,
    // event-independently, so the settled (smaller) height overwrites the
    // inflated boot value even when no resize ever fires.
    const { vp, setHeight } = makeFakeVp(852); // boot reads the inflated full-screen height
    const host = makeResumeHost();
    installViewportHeightTracker(vp, host.win, host.doc);
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("852px");

    // Silent settle: the real usable height is 762 (safe-area/chrome settled),
    // but iOS emits NO resize event, so the resize handler never runs.
    setHeight(762);
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("852px");

    // The boot settle re-read fires on its timer and corrects the var — with no
    // resize event in play.
    vi.advanceTimersByTime(2000);
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("762px");
    expect(document.documentElement.style.getPropertyValue("--vh")).toBe("7.62px");
  });

  it("subscribes to the resize event only (D9 dropped vv.scroll — vvOffsetTop unreliable per WebKit #297779)", () => {
    const addEventListener = vi.fn();
    const vp: VisualViewportLike = { height: 800, addEventListener };
    const host = makeResumeHost();
    installViewportHeightTracker(vp, host.win, host.doc);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });

  // #649/#654 — resume triggers. Each of the three fires the SAME writer via
  // the SAME settle schedule; none of them is a second writer. Every case
  // advances past the boot settle FIRST, so a pass can only come from the
  // resume trigger (leaving the boot timers pending would let #285's schedule
  // silently do the work and make these tests hollow).
  const RESUME_TRIGGERS: ReadonlyArray<{
    name: string;
    fire: (host: ReturnType<typeof makeResumeHost>) => void;
  }> = [
    { name: "visibilitychange → visible", fire: (h) => h.fireVisibilityChange() },
    { name: "pageshow (iOS bfcache/PWA resume)", fire: (h) => h.firePageShow() },
    { name: "window focus", fire: (h) => h.fireFocus() },
  ];

  for (const trigger of RESUME_TRIGGERS) {
    it(`re-reads the viewport on ${trigger.name}, WITHOUT a resize event (#649)`, () => {
      // Foreground with the keyboard up: the last value written is the SHRUNK
      // height. This is the value that survives the app-switch.
      const { vp, setHeight } = makeFakeVp(620);
      const host = makeResumeHost();
      installViewportHeightTracker(vp, host.win, host.doc);
      vi.advanceTimersByTime(2000); // drain the boot settle — it must not be the thing that passes
      expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("620px");

      // App-switch away and back: iOS restores the FULL viewport but fires no
      // `resize`, so the vars stay at the keyboard-open value → the shell is
      // left at half height (the reported symptom).
      setHeight(852);
      expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("620px");

      trigger.fire(host);
      vi.advanceTimersByTime(2000);
      expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("852px");
      expect(document.documentElement.style.getPropertyValue("--vh")).toBe("8.52px");
    });
  }

  it("ignores a visibilitychange to hidden — only a resume re-reads (#649)", () => {
    const { vp, setHeight } = makeFakeVp(620);
    const host = makeResumeHost();
    installViewportHeightTracker(vp, host.win, host.doc);
    vi.advanceTimersByTime(2000);

    host.setVisibility("hidden");
    setHeight(852);
    host.fireVisibilityChange();
    vi.advanceTimersByTime(2000);

    // Backgrounding is not a resume: nothing re-read, the var is untouched.
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("620px");
  });

  it("keeps the resume settle honest: a genuine resize mid-settle wins, never a stale clobber (#649)", () => {
    // The resume settle and the resize handler are the SAME writer reading the
    // SAME live `vv.height` — so an overlapping real keyboard-open during a
    // pending resume re-read must land on the CURRENT height, not replay the
    // height that was live when the resume fired.
    const { vp, fireResize, setHeight } = makeFakeVp(620);
    const host = makeResumeHost();
    installViewportHeightTracker(vp, host.win, host.doc);
    vi.advanceTimersByTime(2000);

    setHeight(852); // resumed full-screen
    host.firePageShow(); // settle schedule armed at 100/400/900
    vi.advanceTimersByTime(100); // first re-read lands the resumed height
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("852px");

    // User taps compose → keyboard opens for real, mid-settle.
    fireResize(620);
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("620px");

    // The still-pending re-reads must NOT restore 852: they read live height.
    vi.advanceTimersByTime(2000);
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("620px");
    expect(document.documentElement.style.getPropertyValue("--vh")).toBe("6.20px");
  });

  it("registers exactly one listener per resume trigger — one writer, more triggers (#654)", () => {
    const { vp } = makeFakeVp(852);
    const host = makeResumeHost();
    installViewportHeightTracker(vp, host.win, host.doc);
    // No fourth mechanism, no wrapper, no second writer: the resume seams carry
    // precisely the three documented triggers.
    expect(host.vvListenerEvents().sort()).toEqual(["focus", "pageshow", "visibilitychange"]);
  });
});

describe("installSmartScrollPin (UX-6 D10)", () => {
  type Handlers = {
    scroll?: () => void;
    touchstart?: () => void;
    touchend?: () => void;
    touchcancel?: () => void;
  };

  function makeFakes(scrollY: number): {
    win: Window;
    doc: Document;
    scrollTo: ReturnType<typeof vi.fn>;
    fireScroll: () => void;
    fireTouchStart: () => void;
    fireTouchEnd: () => void;
  } {
    const scrollTo = vi.fn();
    const winHandlers: Handlers = {};
    const docHandlers: Handlers = {};
    const win = {
      scrollX: 0,
      scrollY,
      scrollTo,
      addEventListener(event: string, h: () => void) {
        if (event === "scroll") winHandlers.scroll = h;
      },
    } as unknown as Window;
    const doc = {
      addEventListener(event: string, h: () => void) {
        if (event === "touchstart") docHandlers.touchstart = h;
        if (event === "touchend") docHandlers.touchend = h;
        if (event === "touchcancel") docHandlers.touchcancel = h;
      },
    } as unknown as Document;
    return {
      win,
      doc,
      scrollTo,
      fireScroll: () => winHandlers.scroll?.(),
      fireTouchStart: () => docHandlers.touchstart?.(),
      fireTouchEnd: () => docHandlers.touchend?.(),
    };
  }

  it("snaps window back to (0, 0) when scroll fires with no touch active", () => {
    const { win, doc, scrollTo, fireScroll } = makeFakes(100);
    installSmartScrollPin(win, doc);
    fireScroll();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("does NOT snap when touch is in flight", () => {
    const { win, doc, scrollTo, fireScroll, fireTouchStart } = makeFakes(100);
    installSmartScrollPin(win, doc);
    fireTouchStart();
    fireScroll();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does NOT snap within 50ms grace after touchend (catches momentum)", () => {
    const { win, doc, scrollTo, fireScroll, fireTouchStart, fireTouchEnd } = makeFakes(100);
    installSmartScrollPin(win, doc);
    fireTouchStart();
    fireTouchEnd();
    // performance.now() advances by sub-ms; grace window applies immediately
    fireScroll();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does NOT call scrollTo when already at (0, 0)", () => {
    const { win, doc, scrollTo, fireScroll } = makeFakes(0);
    installSmartScrollPin(win, doc);
    fireScroll();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("is a no-op when target is undefined", () => {
    expect(() => installSmartScrollPin(undefined)).not.toThrow();
  });
});
