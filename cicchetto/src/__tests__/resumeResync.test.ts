import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installResumeResync, type ResumeWindowLike } from "../lib/resumeResync";

// #1873 — a channel joined on another device is missing from an Android PWA
// that was merely RESUMED, and appears only after a kill-and-reopen.
//
// `channelsBySlug` had exactly two refresh doors: the live `channels_changed`
// broadcast, and a defensive resync gated on the socket transitioning INTO
// "open" from a non-open state (`subscribe.ts`). A frozen process receives
// neither — the broadcast is fanned out best-effort with no live subscriber,
// and `socketHealth` is a RECORD of the last phoenix callback, so with the
// process suspended nothing can write it and the state reads "open" across
// the whole absence. No edge, no refetch; the kill-and-reopen heals it
// because that is a real boot.
//
// This module is the third door: the app-resume signal. The contract tested
// here is deliberately narrow — WHEN the resync verb runs — because what it
// resyncs is `networks.ts`'s business and the socket-edge arm's already.
//
// ⚠️ NOT tested here, and not testable here: that an Android PWA freeze
// produces these events at all. There is no Android on this host and the OS
// freeze cannot be simulated; a synthetic `visibilitychange` is a synthetic
// `visibilitychange`. What is pinned is the contract the resume path obeys
// once the platform delivers one.

/** The bfcache seam, with both halves drivable. */
function fakeWindow(): { win: ResumeWindowLike; pagehide: () => void; pageshow: () => void } {
  const handlers = new Map<string, () => void>();
  return {
    win: {
      addEventListener: (event, h) => {
        handlers.set(event, h);
      },
    },
    pagehide: () => handlers.get("pagehide")?.(),
    pageshow: () => handlers.get("pageshow")?.(),
  };
}

describe("resumeResync — when the resync runs", () => {
  it("does not resync at boot, on the initial pageshow or the initial visible state", () => {
    const resync = vi.fn();
    const [visible] = createSignal(true);
    const { win, pageshow } = fakeWindow();

    // Signals are driven OUTSIDE the root: `createRoot` runs its body inside
    // ONE Solid update cycle, so an effect queued in there does not run until
    // the root returns and a transition made inside is observed only at its
    // final value. Same shape as `documentVisibility.test.ts`.
    const dispose = createRoot((disposeRoot) => {
      installResumeResync({ isVisible: visible, resync, win });
      return disposeRoot;
    });
    // The initial load fires `pageshow` too — with no `pagehide` before it.
    // Boot already fetched the tree, so a resync here would be a second
    // identical request on every cold load.
    pageshow();
    expect(resync).not.toHaveBeenCalled();
    dispose();
  });

  it("resyncs when the document comes back after being away", () => {
    const resync = vi.fn();
    const [visible, setVisible] = createSignal(true);
    const { win } = fakeWindow();

    const dispose = createRoot((disposeRoot) => {
      installResumeResync({ isVisible: visible, resync, win });
      return disposeRoot;
    });
    setVisible(false);
    expect(resync).not.toHaveBeenCalled();
    setVisible(true);
    expect(resync).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("counts a visibility return and a pageshow for ONE resume as one resync", () => {
    // Overlapping triggers are the normal case, not an edge: a PWA resume can
    // deliver both. Two requests for one resume is exactly the doubling this
    // door must not introduce.
    const resync = vi.fn();
    const [visible, setVisible] = createSignal(true);
    const { win, pagehide, pageshow } = fakeWindow();

    const dispose = createRoot((disposeRoot) => {
      installResumeResync({ isVisible: visible, resync, win });
      return disposeRoot;
    });
    // The real order for a PWA that is frozen and restored: it leaves twice
    // over (one departure, two events) and comes back twice over.
    pagehide();
    setVisible(false);
    setVisible(true);
    pageshow();
    expect(resync).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("resyncs again on the NEXT resume — the coalescing is not a latch", () => {
    const resync = vi.fn();
    const [visible, setVisible] = createSignal(true);
    const { win } = fakeWindow();

    const dispose = createRoot((disposeRoot) => {
      installResumeResync({ isVisible: visible, resync, win });
      return disposeRoot;
    });
    setVisible(false);
    setVisible(true);
    setVisible(false);
    setVisible(true);
    expect(resync).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("resyncs on a bfcache restore whose visibility never moved", () => {
    // The case the bfcache pair exists for: the document is frozen and
    // restored with its computed visibility unchanged, so the signal never
    // fires and the visibility arm alone would never see the resume. The
    // `pagehide` this document observed is what separates it from a boot.
    const resync = vi.fn();
    const [visible] = createSignal(true);
    const { win, pagehide, pageshow } = fakeWindow();

    const dispose = createRoot((disposeRoot) => {
      installResumeResync({ isVisible: visible, resync, win });
      return disposeRoot;
    });
    pagehide();
    pageshow();
    expect(resync).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("does not resync while the document goes away and stays away", () => {
    const resync = vi.fn();
    const [visible, setVisible] = createSignal(true);
    const { win } = fakeWindow();

    const dispose = createRoot((disposeRoot) => {
      installResumeResync({ isVisible: visible, resync, win });
      return disposeRoot;
    });
    setVisible(false);
    setVisible(false);
    expect(resync).not.toHaveBeenCalled();
    dispose();
  });
});

// The arm above runs against a hand-made signal, which proves the contract and
// nothing about the wiring. This one runs against the REAL visibility SSOT
// (`documentVisibility.ts` — the same accessor `main.tsx` injects) driven by
// real DOM events, so a change to what that module considers a transition is
// caught here rather than in production.
describe("resumeResync — against the real visibility SSOT", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const setVisibility = (state: "visible" | "hidden"): void => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  };

  it("resyncs once when a backgrounded document is brought back", async () => {
    const { isDocumentVisible } = await import("../lib/documentVisibility");
    const resync = vi.fn();
    const { win } = fakeWindow();

    const dispose = createRoot((disposeRoot) => {
      installResumeResync({ isVisible: isDocumentVisible, resync, win });
      return disposeRoot;
    });
    // Positive control: the signal really is wired to the DOM here, so a zero
    // below would mean the door is shut rather than the events absent.
    expect(isDocumentVisible()).toBe(true);
    setVisibility("hidden");
    expect(isDocumentVisible()).toBe(false);
    expect(resync).not.toHaveBeenCalled();

    setVisibility("visible");
    expect(resync).toHaveBeenCalledTimes(1);
    dispose();
  });
});
