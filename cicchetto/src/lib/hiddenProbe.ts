import { type Accessor, createEffect, on } from "solid-js";

// #1061 — on-device instrument for "cicchetto burns a full core WHILE
// BACKGROUNDED on a dead or flaky network". NOT a fix, and not evidence of
// one: this exists because a static read cannot produce a MAGNITUDE, and the
// source of the burn is still unidentified.
//
// WHY THIS SHAPE. The two fixes that ship with it (the offline connect guard,
// the banner suppression) are real defects, but neither can explain the
// reported symptom: phoenix guards its own `reconnectTimer` with `pageHidden`
// and returns WITHOUT rescheduling (phoenix.mjs:1153), and `requestAnimationFrame`
// does not run while hidden. So the socket path should already be silent in
// the background — and the honest response to "should be" is to measure it,
// not to assert it. One line per hidden episode answers exactly the question
// the static read could not:
//
//   * ws-errors climbing while hidden → phoenix's native ladder IS spinning in
//     the background, contradicting its own pageHidden guard. That would be
//     the burn, and it would be ours.
//   * ws-attempts climbing while hidden → something is calling OUR reconnect
//     door while hidden. Nothing should; if it does, that is the burn.
//   * both flat, ticks at full rate → the page is being allowed to run in the
//     background, and the socket is NOT what it is spending the time on. The
//     WS hypothesis is dead and the search moves elsewhere.
//   * both flat, ticks far below expected → the page is being throttled or
//     frozen, and whatever burns the core is not this document's main thread.
//
// WHAT THIS CANNOT TELL YOU, and must not be read as telling you: `ticks`
// below expected is CONFOUNDED. A busy main thread delays a 1s timer, and so
// does ordinary iOS background throttling — the two are indistinguishable from
// this number alone. `ticks` is here to separate "the page ran" from "the page
// was frozen", NOT to measure CPU. A CPU figure needs a Safari Web Inspector
// profile against the device; nothing here substitutes for that.
//
// The probe itself costs one timer tick per second while hidden, and only with
// the `cic_diag` flag on — it is not armed in an ordinary background session.

export const HIDDEN_TICK_MS = 1000;

// The monotonic tallies read at both ends of an episode. Both come from
// `socketHealth`; the delta over the episode is what the line reports.
export interface HiddenCounters {
  connectAttempts: number;
  errorsTotal: number;
}

export interface HiddenEpisode {
  hiddenMs: number;
  ticks: number;
  attempts: number;
  errors: number;
}

/**
 * Ticks a 1Hz timer should have produced across `hiddenMs`, as the denominator
 * the observed count is read against. Floored: a 2.9s episode owes 2 ticks, and
 * reporting 2/2 rather than 2/3 keeps an unthrottled run from reading as a
 * throttled one.
 */
export function expectedTicks(hiddenMs: number): number {
  return Math.max(0, Math.floor(hiddenMs / HIDDEN_TICK_MS));
}

/** One line per hidden episode — the verdict reads left to right. */
export function formatHiddenProbeLine(episode: HiddenEpisode): string {
  const seconds = (episode.hiddenMs / 1000).toFixed(1);
  return [
    `hidden ${seconds}s`,
    `ticks=${episode.ticks}/${expectedTicks(episode.hiddenMs)}`,
    `ws-attempts=+${episode.attempts}`,
    `ws-errors=+${episode.errors}`,
  ].join(" ");
}

export interface HiddenProbeDeps {
  isVisible: Accessor<boolean>;
  /** `isDiagEnabled` in production — nothing runs when diagnostics are off. */
  enabled: () => boolean;
  push: (line: string) => void;
  now: () => number;
  counters: () => HiddenCounters;
  /** Start a 1Hz ticker; returns the stop verb. */
  startTicker: (onTick: () => void) => () => void;
}

/**
 * Arm the hidden-episode probe. Nothing runs, and no line is recorded, unless
 * `enabled()` was true at the moment the page went hidden.
 *
 * The gate is read at HIDE time and the episode carries that decision to its
 * end: a flag flipped mid-episode would otherwise emit a line whose counters
 * started from a baseline that was never taken.
 */
export function installHiddenProbe(deps: HiddenProbeDeps): void {
  let episodeStart: number | null = null;
  let baseline: HiddenCounters | null = null;
  let ticks = 0;
  let stopTicker: (() => void) | null = null;

  const beginHidden = (): void => {
    if (!deps.enabled()) return;
    episodeStart = deps.now();
    baseline = deps.counters();
    ticks = 0;
    stopTicker = deps.startTicker(() => {
      ticks++;
    });
  };

  const endHidden = (): void => {
    // No open episode: the page became visible without this probe having seen
    // it go hidden (initial mount, or diagnostics turned on mid-background).
    // Reporting a line here would invent a baseline.
    if (episodeStart === null || baseline === null) return;
    stopTicker?.();
    stopTicker = null;
    const now = deps.counters();
    deps.push(
      formatHiddenProbeLine({
        hiddenMs: deps.now() - episodeStart,
        ticks,
        attempts: now.connectAttempts - baseline.connectAttempts,
        errors: now.errorsTotal - baseline.errorsTotal,
      }),
    );
    episodeStart = null;
    baseline = null;
  };

  createEffect(
    on(deps.isVisible, (visible, prev) => {
      // `prev === undefined` is the initial mount, which is neither a hide nor
      // a resume.
      if (prev === true && visible === false) beginHidden();
      else if (prev === false && visible === true) endHidden();
    }),
  );
}
