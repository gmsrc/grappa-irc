import { createRoot, createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUNDLE_REFRESH_MINUTES_KEY,
  bundleRefreshDwellMs,
  DEFAULT_BUNDLE_REFRESH_MINUTES,
  DEFAULT_STALE_RESUME_HOURS,
  installStaleResumeReload,
  isStaleResume,
  markActive,
  type ReloadReason,
  readLastActive,
  STALE_RESUME_HOURS_KEY,
  STALE_RESUME_STAMP_KEY,
  shouldAutoRefreshBundle,
  staleResumeThresholdMs,
} from "../lib/staleResume";

// #695 — reload the whole client on resume after a prolonged absence.
//
// The interval is measured from a PERSISTED stamp, never from a timer: the
// whole point is a document iOS suspended for two days, with no JS running
// for the entire window. Every test here therefore drives `now` as a plain
// value and never advances a fake clock — if a test needed a timer to trip
// the threshold, the implementation would be measuring the wrong thing.

const HOUR = 3_600_000;
const MINUTE = 60_000;

// setupTests.ts installs a fresh localStorage per test but leaves jsdom's
// sessionStorage — where the stamp lives — untouched, so it would bleed the
// stamp between cases.
beforeEach(() => {
  sessionStorage.clear();
});

// Solid's effect queue is flushed on a macrotask (same idiom as
// badge.test.ts's mountBadgeSync case).
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Harness {
  visible: (v: boolean) => void;
  pageshow: () => void;
  // The verb `installStaleResumeReload` hands back — what main.tsx wires into
  // the #318 foreground heartbeat.
  heartbeatTick: () => void;
  setNow: (t: number) => void;
  // #674 — the bundle-hash mismatch predicate (`shouldShowRefreshBanner` in
  // production). Flipping it mid-test is how a case models the on-rejoin
  // `bundle_hash` push landing AFTER the resume that observed the absence.
  setMismatch: (v: boolean) => void;
  // #775 — the reload carries WHICH branch asked for it, so the composition
  // root can announce an applied deploy and stay quiet about a document
  // thrown away for age.
  reload: ReturnType<typeof vi.fn<(reason: ReloadReason) => void>>;
  dispose: () => void;
}

function install(startNow: number): Harness {
  let now = startNow;
  const reload = vi.fn<(reason: ReloadReason) => void>();
  const [isVisible, setVisible] = createSignal(true);
  const [bundleMismatch, setBundleMismatch] = createSignal(false);
  const handlers: Array<() => void> = [];
  let dispose = (): void => {};
  let check = (): void => {};
  createRoot((d) => {
    dispose = d;
    check = installStaleResumeReload({
      isVisible,
      bundleMismatch,
      now: () => now,
      reload,
      win: {
        addEventListener: (_event: "pageshow", handler: () => void) => {
          handlers.push(handler);
        },
      },
    });
  });
  return {
    visible: setVisible,
    pageshow: () => {
      for (const h of handlers) h();
    },
    heartbeatTick: () => check(),
    setNow: (t: number) => {
      now = t;
    },
    setMismatch: setBundleMismatch,
    reload,
    dispose,
  };
}

describe("staleResume — threshold resolution", () => {
  it("defaults to 48h when no override is stored", () => {
    expect(DEFAULT_STALE_RESUME_HOURS).toBe(48);
    expect(staleResumeThresholdMs()).toBe(48 * HOUR);
  });

  it("honours a stored override, so the threshold moves without a deploy", () => {
    localStorage.setItem(STALE_RESUME_HOURS_KEY, "6");
    expect(staleResumeThresholdMs()).toBe(6 * HOUR);
  });

  it("falls back to the default on a non-numeric override", () => {
    localStorage.setItem(STALE_RESUME_HOURS_KEY, "soon");
    expect(staleResumeThresholdMs()).toBe(DEFAULT_STALE_RESUME_HOURS * HOUR);
  });

  it("falls back to the default on a non-positive override — a typo must not reload on every resume", () => {
    localStorage.setItem(STALE_RESUME_HOURS_KEY, "0");
    expect(staleResumeThresholdMs()).toBe(DEFAULT_STALE_RESUME_HOURS * HOUR);
    localStorage.setItem(STALE_RESUME_HOURS_KEY, "-3");
    expect(staleResumeThresholdMs()).toBe(DEFAULT_STALE_RESUME_HOURS * HOUR);
  });
});

describe("staleResume — the persisted stamp", () => {
  it("markActive writes the stamp and readLastActive reads it back", () => {
    markActive(1_700_000_000_000);
    expect(readLastActive()).toBe(1_700_000_000_000);
  });

  it("lives in sessionStorage, so a foreground tab in another window cannot refresh it", () => {
    markActive(1_700_000_000_000);
    expect(sessionStorage.getItem(STALE_RESUME_STAMP_KEY)).toBe("1700000000000");
    expect(localStorage.getItem(STALE_RESUME_STAMP_KEY)).toBeNull();
  });

  it("readLastActive is null when nothing was ever stamped", () => {
    expect(readLastActive()).toBeNull();
  });

  it("readLastActive is null on a corrupt stamp", () => {
    sessionStorage.setItem(STALE_RESUME_STAMP_KEY, "yesterday");
    expect(readLastActive()).toBeNull();
  });
});

describe("isStaleResume — the decision", () => {
  const t0 = 1_700_000_000_000;

  it("is false under the threshold", () => {
    expect(isStaleResume(t0 + 47 * HOUR, t0, 48 * HOUR)).toBe(false);
  });

  it("is false exactly at the threshold", () => {
    expect(isStaleResume(t0 + 48 * HOUR, t0, 48 * HOUR)).toBe(false);
  });

  it("is true over the threshold", () => {
    expect(isStaleResume(t0 + 48 * HOUR + 1, t0, 48 * HOUR)).toBe(true);
  });

  it("is false with no stamp — a first-ever boot has nothing to be stale against", () => {
    expect(isStaleResume(t0 + 1000 * HOUR, null, 48 * HOUR)).toBe(false);
  });

  it("is false on a future-dated stamp — a backwards clock step must not reload", () => {
    expect(isStaleResume(t0, t0 + 10 * HOUR, 48 * HOUR)).toBe(false);
  });
});

describe("installStaleResumeReload", () => {
  const t0 = 1_700_000_000_000;

  it("stamps this document active at install, so the document that just reloaded does not reload again", async () => {
    // The stale stamp survives the reload (same window, same sessionStorage).
    // Without the pre-arm write the fresh document would read it, trip, and
    // reload again — the loop the issue calls out by name.
    markActive(t0 - 336 * HOUR);
    const h = install(t0);
    await flush();
    expect(h.reload).not.toHaveBeenCalled();
    expect(readLastActive()).toBe(t0);
    h.dispose();
  });

  it("does not reload on a resume under the threshold", async () => {
    const h = install(t0);
    await flush();
    h.visible(false);
    await flush();
    h.setNow(t0 + 47 * HOUR);
    h.visible(true);
    await flush();
    expect(h.reload).not.toHaveBeenCalled();
    h.dispose();
  });

  it("reloads on a resume over the threshold, driven by the stamp with no timer running", async () => {
    const h = install(t0);
    await flush();
    h.visible(false);
    await flush();
    // The OS suspended the document here: no heartbeat tick, no
    // visibilitychange, no JS at all for 50 hours. Only the stamp survives.
    expect(readLastActive()).toBe(t0);
    h.setNow(t0 + 50 * HOUR);
    h.visible(true);
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    // #775 — an absence reload has nothing to announce afterwards.
    expect(h.reload).toHaveBeenCalledWith("absence");
    h.dispose();
  });

  it("refreshes the stamp as it reloads, so more triggers cannot stack a second reload", async () => {
    const h = install(t0);
    await flush();
    h.visible(false);
    await flush();
    h.setNow(t0 + 50 * HOUR);
    h.visible(true);
    await flush();
    // More resume triggers arrive before the navigation completes — a
    // pageshow and another visibility round-trip.
    h.pageshow();
    h.visible(false);
    await flush();
    h.visible(true);
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    // And the document is left healthy rather than wedged: a reload that
    // never lands must not disable the feature for this document's whole
    // remaining life.
    expect(readLastActive()).toBe(t0 + 50 * HOUR);
    h.dispose();
  });

  it("re-arms after a reload that never landed — a later genuine absence still trips", async () => {
    const h = install(t0);
    await flush();
    h.setNow(t0 + 50 * HOUR);
    h.pageshow();
    expect(h.reload).toHaveBeenCalledTimes(1);
    // The navigation was blocked; this document lives on and is used again.
    h.setNow(t0 + 200 * HOUR);
    h.pageshow();
    expect(h.reload).toHaveBeenCalledTimes(2);
    h.dispose();
  });

  it("trips on the foreground heartbeat tick — the iOS thaw that fires no visibility transition", async () => {
    const h = install(t0);
    await flush();
    // iOS froze the document without firing visibilitychange, so the signal
    // never changed and pageshow never fired. The interval was frozen too;
    // its first tick after the thaw is the only observer left.
    h.setNow(t0 + 50 * HOUR);
    h.heartbeatTick();
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it("a heartbeat tick during genuine foreground use only refreshes the stamp", async () => {
    const h = install(t0);
    await flush();
    h.setNow(t0 + 30_000);
    h.heartbeatTick();
    expect(h.reload).not.toHaveBeenCalled();
    expect(readLastActive()).toBe(t0 + 30_000);
    h.dispose();
  });

  it("reloads on a pageshow — the bfcache restore the visibility signal never sees", async () => {
    const h = install(t0);
    await flush();
    h.setNow(t0 + 50 * HOUR);
    h.pageshow();
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it("refreshes the stamp on every trigger while still fresh", async () => {
    const h = install(t0);
    await flush();
    h.setNow(t0 + 2 * HOUR);
    h.visible(false);
    await flush();
    expect(readLastActive()).toBe(t0 + 2 * HOUR);
    h.setNow(t0 + 3 * HOUR);
    h.pageshow();
    expect(readLastActive()).toBe(t0 + 3 * HOUR);
    h.dispose();
  });

  it("honours the stored override — a 6h threshold trips on a 7h absence", async () => {
    localStorage.setItem(STALE_RESUME_HOURS_KEY, "6");
    const h = install(t0);
    await flush();
    h.visible(false);
    await flush();
    h.setNow(t0 + 7 * HOUR);
    h.visible(true);
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.dispose();
  });
});

describe("bundleRefreshDwellMs — the #674 knob", () => {
  // A knob of its OWN. The server's auto-away debounce happens to start at the
  // same 10 minutes, but the two answer different questions ("should your peers
  // be told you are away" vs "may I throw this document away") and #348 may make
  // the server one user-configurable. Never derive one from the other.
  it("defaults to 10 minutes", () => {
    expect(DEFAULT_BUNDLE_REFRESH_MINUTES).toBe(10);
    expect(bundleRefreshDwellMs()).toBe(10 * MINUTE);
  });

  it("is independent of the 48h stale-resume threshold", () => {
    localStorage.setItem(STALE_RESUME_HOURS_KEY, "6");
    expect(bundleRefreshDwellMs()).toBe(DEFAULT_BUNDLE_REFRESH_MINUTES * MINUTE);
  });

  it("honours a stored override", () => {
    localStorage.setItem(BUNDLE_REFRESH_MINUTES_KEY, "30");
    expect(bundleRefreshDwellMs()).toBe(30 * MINUTE);
  });

  it("falls back to the default on a non-numeric or non-positive override", () => {
    localStorage.setItem(BUNDLE_REFRESH_MINUTES_KEY, "soon");
    expect(bundleRefreshDwellMs()).toBe(DEFAULT_BUNDLE_REFRESH_MINUTES * MINUTE);
    localStorage.setItem(BUNDLE_REFRESH_MINUTES_KEY, "0");
    expect(bundleRefreshDwellMs()).toBe(DEFAULT_BUNDLE_REFRESH_MINUTES * MINUTE);
    localStorage.setItem(BUNDLE_REFRESH_MINUTES_KEY, "-5");
    expect(bundleRefreshDwellMs()).toBe(DEFAULT_BUNDLE_REFRESH_MINUTES * MINUTE);
  });
});

describe("shouldAutoRefreshBundle — the decision", () => {
  const dwell = 10 * MINUTE;

  it("is false with no mismatch, however long the gap", () => {
    expect(shouldAutoRefreshBundle(48 * HOUR, dwell, false)).toBe(false);
  });

  it("is false under and exactly at the dwell", () => {
    expect(shouldAutoRefreshBundle(9 * MINUTE, dwell, true)).toBe(false);
    expect(shouldAutoRefreshBundle(dwell, dwell, true)).toBe(false);
  });

  it("is true over the dwell with a mismatch", () => {
    expect(shouldAutoRefreshBundle(dwell + 1, dwell, true)).toBe(true);
  });
});

describe("installStaleResumeReload — #674 bundle auto-refresh", () => {
  const t0 = 1_700_000_000_000;

  // THE regression this branch exists for. `bundle_hash` rides the user-topic
  // JOIN, so on resume it lands a rejoin later than the visibility transition
  // that observed the absence — by which time `check` has already refreshed the
  // stamp and `now - lastActive` reads ~0. A verdict computed at hash-arrival
  // time would therefore be false forever, and the feature would never fire for
  // its single most common case: the operator deployed while you were away.
  it("reloads on a mismatch that arrives AFTER the resume, judged on the gap at the resume", async () => {
    const h = install(t0);
    await flush();
    h.visible(false);
    await flush();
    h.setNow(t0 + 20 * MINUTE);
    h.visible(true);
    await flush();
    // The resume itself saw no mismatch — the socket has not rejoined yet.
    expect(h.reload).not.toHaveBeenCalled();
    // The stamp has already been refreshed, so a re-derived gap would be ~0.
    expect(readLastActive()).toBe(t0 + 20 * MINUTE);
    // Rejoin completes and the server advertises the new bundle.
    h.setMismatch(true);
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    // #775 — and it says so, which is what earns the toast after the reload.
    expect(h.reload).toHaveBeenCalledWith("bundle");
    h.dispose();
  });

  it("does not reload when the mismatch arrives after a SHORT absence — the banner keeps that case", async () => {
    const h = install(t0);
    await flush();
    h.visible(false);
    await flush();
    h.setNow(t0 + 30_000);
    h.visible(true);
    await flush();
    h.setMismatch(true);
    await flush();
    expect(h.reload).not.toHaveBeenCalled();
    h.dispose();
  });

  it("reloads when a long absence ends and the mismatch was already known", async () => {
    const h = install(t0);
    await flush();
    h.setMismatch(true);
    await flush();
    expect(h.reload).not.toHaveBeenCalled();
    h.visible(false);
    await flush();
    h.setNow(t0 + 20 * MINUTE);
    h.visible(true);
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it("never reloads while genuinely foreground — the heartbeat keeps the gap short", async () => {
    const h = install(t0);
    await flush();
    h.setMismatch(true);
    await flush();
    // Six hours of continuous foreground use, one #318 tick every 30s.
    for (let i = 1; i <= 720; i++) {
      h.setNow(t0 + i * 30_000);
      h.heartbeatTick();
    }
    await flush();
    expect(h.reload).not.toHaveBeenCalled();
    h.dispose();
  });

  it("fires once per absence, not once per trigger", async () => {
    const h = install(t0);
    await flush();
    h.visible(false);
    await flush();
    h.setNow(t0 + 20 * MINUTE);
    h.visible(true);
    h.setMismatch(true);
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.pageshow();
    h.visible(false);
    await flush();
    h.visible(true);
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  // Constraint: no boolean latch, and no loop. A reload that never lands leaves
  // the document healthy — the next check overwrites the captured gap with a
  // short one and the dwell simply stops being satisfied.
  it("self-closes after a reload that never landed, without a latch", async () => {
    const h = install(t0);
    await flush();
    h.visible(false);
    await flush();
    h.setNow(t0 + 20 * MINUTE);
    h.visible(true);
    h.setMismatch(true);
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    // Navigation was blocked; this document lives on in the foreground.
    h.setNow(t0 + 21 * MINUTE);
    h.heartbeatTick();
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    // And a LATER genuine absence still trips — the feature is not disabled.
    h.visible(false);
    await flush();
    h.setNow(t0 + 45 * MINUTE);
    h.visible(true);
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(2);
    h.dispose();
  });

  // Constraint: a broken network must not be able to loop. No rejoin means no
  // `bundle_hash`, so the mismatch predicate stays false and nothing fires —
  // while the stamp keeps advancing, so the 48h branch cannot accumulate either.
  it("cannot loop on a broken network — no mismatch, no reload, stamp still advancing", async () => {
    const h = install(t0);
    await flush();
    for (let i = 1; i <= 5; i++) {
      h.visible(false);
      await flush();
      h.setNow(t0 + i * 20 * MINUTE);
      h.visible(true);
      await flush();
    }
    expect(h.reload).not.toHaveBeenCalled();
    expect(readLastActive()).toBe(t0 + 5 * 20 * MINUTE);
    h.dispose();
  });

  // Constraint: the stamp is written unconditionally, even when the
  // discriminant is unavailable. Withholding it would starve the 48h branch.
  it("stamps on every check even with the discriminant unavailable", async () => {
    const h = install(t0);
    await flush();
    h.visible(false);
    await flush();
    h.setNow(t0 + 20 * MINUTE);
    h.visible(true);
    await flush();
    expect(readLastActive()).toBe(t0 + 20 * MINUTE);
    h.dispose();
  });

  // Constraint: the two branches stay independent.
  it("the 48h branch fires without consulting the bundle mismatch", async () => {
    const h = install(t0);
    await flush();
    h.visible(false);
    await flush();
    h.setNow(t0 + 50 * HOUR);
    h.visible(true);
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it("the bundle branch fires without consulting the staleness threshold", async () => {
    localStorage.setItem(STALE_RESUME_HOURS_KEY, "9000");
    const h = install(t0);
    await flush();
    h.visible(false);
    await flush();
    h.setNow(t0 + 20 * MINUTE);
    h.visible(true);
    h.setMismatch(true);
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.dispose();
  });
});
