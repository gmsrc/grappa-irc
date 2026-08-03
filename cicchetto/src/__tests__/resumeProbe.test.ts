import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
  entryTypeSupport,
  formatResumeProbeLine,
  installResumeProbe,
  PROBE_WINDOW_MS,
  type ProbePerformance,
  summariseFrameGaps,
} from "../lib/resumeProbe";

// #697 — on-device instrument for "iOS resume leaves the UI unresponsive".
//
// The pure parts are exhaustively tested here; the arming is covered only for
// the contract that matters operationally (off unless diag is on, one summary
// line per resume, observers disconnected). Whether a real iOS PWA freezes is
// NOT testable here by construction — that is the whole reason the instrument
// exists.

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The single line the probe emitted. */
const emitted = (push: ReturnType<typeof vi.fn>): string => String(push.mock.calls[0]?.[0]);

describe("summariseFrameGaps", () => {
  // samples[0] is the ARM time, so the first gap is resume→first frame — the
  // interval a frozen document stretches, and the one worth seeing.
  it("reports frame count, max gap and span", () => {
    expect(summariseFrameGaps([100, 116, 132, 148])).toEqual({
      frames: 3,
      maxGapMs: 16,
      spanMs: 48,
    });
  });

  it("counts the arm→first-frame interval as a gap", () => {
    expect(summariseFrameGaps([0, 3820, 3836])).toEqual({
      frames: 2,
      maxGapMs: 3820,
      spanMs: 3836,
    });
  });

  it("rounds fractional timestamps", () => {
    const s = summariseFrameGaps([0, 16.4, 33.1]);
    expect(s.maxGapMs).toBe(17);
    expect(s.spanMs).toBe(33);
  });

  it("is empty with no frames at all — a document frozen for the whole window", () => {
    expect(summariseFrameGaps([1000])).toEqual({ frames: 0, maxGapMs: 0, spanMs: 0 });
    expect(summariseFrameGaps([])).toEqual({ frames: 0, maxGapMs: 0, spanMs: 0 });
  });
});

describe("entryTypeSupport", () => {
  it("is ok when the engine lists the entry type", () => {
    expect(entryTypeSupport(["longtask", "event"], "longtask")).toBe("ok");
  });

  it("is unsupported when the engine omits it", () => {
    expect(entryTypeSupport(["event"], "longtask")).toBe("unsupported");
  });

  // WebKit is the target and its support for these is not something to assume.
  it("is unsupported when the engine exposes no list at all", () => {
    expect(entryTypeSupport(undefined, "longtask")).toBe("unsupported");
  });
});

describe("formatResumeProbeLine", () => {
  const summary = { frames: 41, maxGapMs: 3820, spanMs: 10000 };

  // THE honesty rule: an absent API and a genuinely quiet observer must not
  // render the same, or a missing measurement reads as a clean measurement.
  it("distinguishes an unsupported observer from one that saw nothing", () => {
    const unsupported = formatResumeProbeLine(
      summary,
      { support: "unsupported", count: 0, maxMs: 0 },
      { support: "ok", count: 0, maxMs: 0 },
    );
    expect(unsupported).toContain("longtask:unsupported");
    expect(unsupported).toContain("input:none");
    expect(unsupported).not.toContain("longtask:none");
  });

  it("reports count and max when the observer saw entries", () => {
    const line = formatResumeProbeLine(
      summary,
      { support: "ok", count: 2, maxMs: 3810 },
      { support: "ok", count: 3, maxMs: 512 },
    );
    expect(line).toContain("longtask:2 max=3810ms");
    expect(line).toContain("input:3 max=512ms");
  });

  it("leads with the frame summary so the blocked/not-blocked verdict reads first", () => {
    const line = formatResumeProbeLine(
      summary,
      { support: "ok", count: 0, maxMs: 0 },
      { support: "ok", count: 0, maxMs: 0 },
    );
    expect(line.startsWith("resume 10000ms frames=41 maxgap=3820ms")).toBe(true);
  });
});

interface Harness {
  visible: (v: boolean) => void;
  pageshow: () => void;
  runFrames: (times: number[]) => void;
  push: ReturnType<typeof vi.fn>;
  disconnects: number;
  dispose: () => void;
}

function install(opts: { enabled: boolean; supported: readonly string[] | undefined }): Harness {
  const push = vi.fn();
  const [isVisible, setVisible] = createSignal(true);
  const handlers: Array<() => void> = [];
  let frameCb: ((t: number) => void) | null = null;
  let now = 0;
  const state = { disconnects: 0 };
  const perf: ProbePerformance = {
    supportedEntryTypes: () => opts.supported,
    observe: (entryType) => {
      if (!(opts.supported ?? []).includes(entryType)) return null;
      return () => {
        state.disconnects += 1;
      };
    },
  };
  let dispose = (): void => {};
  createRoot((d) => {
    dispose = d;
    installResumeProbe({
      isVisible,
      enabled: () => opts.enabled,
      push,
      now: () => now,
      raf: (cb) => {
        frameCb = cb;
      },
      perf,
      win: {
        addEventListener: (_e: "pageshow", h: () => void) => {
          handlers.push(h);
        },
      },
    });
  });
  return {
    visible: setVisible,
    pageshow: () => {
      for (const h of handlers) h();
    },
    runFrames: (times) => {
      for (const t of times) {
        now = t;
        const cb = frameCb;
        frameCb = null;
        cb?.(t);
      }
    },
    push,
    get disconnects() {
      return state.disconnects;
    },
    dispose,
  };
}

describe("installResumeProbe", () => {
  // The operational requirement: nothing runs for a user who has not turned
  // diagnostics on.
  it("does nothing at all with diagnostics off", async () => {
    const h = install({ enabled: false, supported: ["longtask"] });
    await flush();
    h.visible(false);
    await flush();
    h.visible(true);
    await flush();
    h.runFrames([0, 16, PROBE_WINDOW_MS + 1]);
    expect(h.push).not.toHaveBeenCalled();
    h.dispose();
  });

  it("emits exactly ONE summary line per resume, not one per frame", async () => {
    const h = install({ enabled: true, supported: ["longtask", "event"] });
    await flush();
    h.visible(false);
    await flush();
    h.visible(true);
    await flush();
    h.runFrames([0, 16, 32, PROBE_WINDOW_MS + 1]);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(emitted(h.push)).toContain("resume ");
    h.dispose();
  });

  it("marks an unsupported observer rather than reporting a quiet one", async () => {
    const h = install({ enabled: true, supported: [] });
    await flush();
    h.visible(false);
    await flush();
    h.visible(true);
    await flush();
    h.runFrames([0, PROBE_WINDOW_MS + 1]);
    expect(emitted(h.push)).toContain("longtask:unsupported");
    expect(emitted(h.push)).toContain("input:unsupported");
    h.dispose();
  });

  it("disconnects its observers when the window closes", async () => {
    const h = install({ enabled: true, supported: ["longtask", "event"] });
    await flush();
    h.visible(false);
    await flush();
    h.visible(true);
    await flush();
    expect(h.disconnects).toBe(0);
    h.runFrames([0, PROBE_WINDOW_MS + 1]);
    expect(h.disconnects).toBe(2);
    h.dispose();
  });

  it("arms on pageshow too — the bfcache restore the visibility signal never sees", async () => {
    const h = install({ enabled: true, supported: [] });
    await flush();
    h.pageshow();
    h.runFrames([0, PROBE_WINDOW_MS + 1]);
    expect(h.push).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it("does not arm a second window while one is already running", async () => {
    const h = install({ enabled: true, supported: [] });
    await flush();
    h.visible(false);
    await flush();
    h.visible(true);
    await flush();
    // A pageshow lands mid-window — overlapping triggers are expected on iOS.
    h.pageshow();
    h.runFrames([0, PROBE_WINDOW_MS + 1]);
    expect(h.push).toHaveBeenCalledTimes(1);
    h.dispose();
  });
});
