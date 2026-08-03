import { type Accessor, createEffect, on } from "solid-js";

// #697 — on-device instrument for "iOS resume leaves the UI unresponsive for
// 3-4 seconds". NOT a fix: this exists to decide WHICH bug we have, because a
// static read of the resume path could not.
//
// WHY THE SYMPTOM AND NOT THE TEN CONSUMERS. Ten things run on
// visibility → visible (kickReconnect, refreshScrollback, the viewport
// writer, push resubscribe, badge, presence report + heartbeat, two
// ScrollbackPane effects, two cursor gates). Wrapping all ten would be
// invasive, would perturb what it measures, and assumes the answer is in
// there. One cheap measurement of the SYMPTOM eliminates half the hypothesis
// space first:
//
//   * a large frame gap   → our JS blocks the main thread; only THEN is
//                           per-consumer attribution worth adding;
//   * no gap, taps dead   → not our main thread at all — platform behaviour
//                           on PWA resume, and #697 gets reframed;
//   * neither             → the freeze did not happen on that resume, and the
//                           repro needs work before anything else does.
//
// THE PRIMARY SIGNAL IS ENGINE-AGNOSTIC ON PURPOSE. `requestAnimationFrame`
// scheduling delay needs no API support and works on WebKit, which the
// interesting observers may not. `samples[0]` is the ARM time, so the first
// gap measured is resume → first frame: exactly the interval a frozen
// document stretches.
//
// The observers are strictly secondary and strictly feature-detected. An
// engine that does not implement an entry type reports `unsupported`, NEVER an
// empty result — a missing measurement must not read as a clean one (CLAUDE.md
// log honesty: state what you OBSERVED, not the absence of work).
//
// KNOWN LIMITATION, do not read an absent line as an absent freeze: the probe
// arms on the visibility transition and on `pageshow`. iOS frequently thaws a
// document with NEITHER, and `requestAnimationFrame` does not run while
// hidden, so a resume that fires no transition is not measured at all. If a
// freeze is reported with no line to match it, that is this gap, not evidence.

export const PROBE_WINDOW_MS = 10_000;

export interface FrameGapSummary {
  frames: number;
  maxGapMs: number;
  spanMs: number;
}

export type EntrySupport = "ok" | "unsupported";

export interface ObservedEntries {
  support: EntrySupport;
  count: number;
  maxMs: number;
}

/**
 * Frame count, worst inter-frame gap and total span across a sample run.
 *
 * `samples[0]` is the arm time, so the first interval is resume → first frame.
 * Fewer than two samples means no frame ever ran — a document frozen for the
 * whole window — and reports zeroes rather than inventing a gap.
 */
export function summariseFrameGaps(samples: readonly number[]): FrameGapSummary {
  const [armedAt] = samples;
  const last = samples.at(-1);
  // The undefined arms are unreachable once length >= 2; they are here to
  // narrow under `noUncheckedIndexedAccess`, not to defend against anything.
  if (samples.length < 2 || armedAt === undefined || last === undefined) {
    return { frames: 0, maxGapMs: 0, spanMs: 0 };
  }
  let maxGap = 0;
  let prev = armedAt;
  for (const t of samples.slice(1)) {
    const gap = t - prev;
    if (gap > maxGap) maxGap = gap;
    prev = t;
  }
  return {
    frames: samples.length - 1,
    maxGapMs: Math.round(maxGap),
    spanMs: Math.round(last - armedAt),
  };
}

/** Does this engine implement `entryType`? An absent list is unsupported. */
export function entryTypeSupport(
  supported: readonly string[] | undefined,
  entryType: string,
): EntrySupport {
  return supported !== undefined && supported.includes(entryType) ? "ok" : "unsupported";
}

function formatObserved(label: string, observed: ObservedEntries): string {
  // `unsupported` and `none` are deliberately distinct renderings.
  if (observed.support === "unsupported") return `${label}:unsupported`;
  if (observed.count === 0) return `${label}:none`;
  return `${label}:${observed.count} max=${observed.maxMs}ms`;
}

/** One line per resume, frame summary first — the verdict reads left to right. */
export function formatResumeProbeLine(
  summary: FrameGapSummary,
  longTask: ObservedEntries,
  input: ObservedEntries,
): string {
  return [
    `resume ${summary.spanMs}ms frames=${summary.frames} maxgap=${summary.maxGapMs}ms`,
    formatObserved("longtask", longTask),
    formatObserved("input", input),
  ].join(" | ");
}

export interface ProbePerformance {
  supportedEntryTypes(): readonly string[] | undefined;
  /** Start observing; returns a disconnect verb, or null when unsupported. */
  observe(entryType: string, onValues: (values: readonly number[]) => void): (() => void) | null;
}

export interface ProbeWindowLike {
  addEventListener(event: "pageshow", handler: () => void): void;
}

export interface ResumeProbeDeps {
  isVisible: Accessor<boolean>;
  /** `isDiagEnabled` in production — nothing runs when diagnostics are off. */
  enabled: () => boolean;
  push: (line: string) => void;
  now: () => number;
  raf: (cb: (t: number) => void) => void;
  perf: ProbePerformance;
  win: ProbeWindowLike;
}

const LONGTASK = "longtask";
const EVENT = "event";

/**
 * Arm the resume probe. No-op while `enabled()` is false.
 *
 * On each resume it samples frame scheduling for `PROBE_WINDOW_MS`, then emits
 * ONE summary line — one per frame would drain `diagLog`'s 40-entry ring in a
 * single resume.
 */
export function installResumeProbe(deps: ResumeProbeDeps): void {
  let running = false;

  const arm = (): void => {
    if (!deps.enabled()) return;
    // Overlapping triggers are normal on iOS (a visibility transition AND a
    // pageshow for one resume); the second must not start a rival window.
    // Cleared when the window closes, so this is a re-entrancy guard, not a
    // latch that can disable the probe for good.
    if (running) return;
    running = true;

    const armedAt = deps.now();
    const samples: number[] = [armedAt];
    const longTaskValues: number[] = [];
    const inputValues: number[] = [];

    const supported = deps.perf.supportedEntryTypes();
    const stopLongTask = deps.perf.observe(LONGTASK, (v) => longTaskValues.push(...v));
    const stopInput = deps.perf.observe(EVENT, (v) => inputValues.push(...v));

    const finish = (): void => {
      stopLongTask?.();
      stopInput?.();
      const observed = (entryType: string, values: readonly number[]): ObservedEntries => ({
        support: entryTypeSupport(supported, entryType),
        count: values.length,
        maxMs: values.length === 0 ? 0 : Math.round(Math.max(...values)),
      });
      deps.push(
        formatResumeProbeLine(
          summariseFrameGaps(samples),
          observed(LONGTASK, longTaskValues),
          observed(EVENT, inputValues),
        ),
      );
      running = false;
    };

    const step = (t: number): void => {
      samples.push(t);
      if (t - armedAt >= PROBE_WINDOW_MS) finish();
      else deps.raf(step);
    };
    deps.raf(step);
  };

  deps.win.addEventListener("pageshow", arm);
  createEffect(
    on(deps.isVisible, (visible, prev) => {
      // `prev === undefined` is the initial mount, which is a page load, not a
      // resume. Only false→true is one.
      if (prev === false && visible === true) arm();
    }),
  );
}

/**
 * The real `PerformanceObserver` seam.
 *
 * `longtask` reports its own `duration`; an `event` entry's interesting number
 * is `processingStart - startTime` — the input delay, which IS the reported
 * symptom ("taps do nothing"). Neither is assumed to exist.
 */
export function browserProbePerformance(): ProbePerformance {
  return {
    supportedEntryTypes: () =>
      typeof PerformanceObserver === "undefined"
        ? undefined
        : PerformanceObserver.supportedEntryTypes,
    observe: (entryType, onValues) => {
      if (entryTypeSupport(PerformanceObserver?.supportedEntryTypes, entryType) === "unsupported") {
        return null;
      }
      const observer = new PerformanceObserver((list) => {
        onValues(
          list.getEntries().map((entry) => {
            if (entryType !== EVENT) return entry.duration;
            const timing = entry as PerformanceEventTiming;
            return timing.processingStart - timing.startTime;
          }),
        );
      });
      observer.observe({ type: entryType, buffered: true });
      return () => observer.disconnect();
    },
  };
}
