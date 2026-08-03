import { type Accessor, createEffect, createSignal } from "solid-js";

// Resume-time reload decisions. TWO independent reasons to throw the document
// away, sharing one resume check, one stamp and one reload verb.
//
// #695 — a prolonged ABSENCE. A long-lived PWA document degrades ("Safari goes
// mad after a while"), so a document iOS suspended for two days is worth
// throwing away rather than resuming. Fires on elapsed inactivity whether or
// not a new bundle exists.
//
// #674 — a DEPLOY landed while nobody was looking. The service worker already
// installs the new bundle silently, but the open page keeps executing the JS it
// booted with, so a long-lived PWA session runs old code indefinitely. When the
// operator has been away long enough that a reload cannot eat anything they
// were mid-way through, apply it without asking; otherwise the #674 refresh
// banner keeps the case and the operator owns the timing.
//
// The two branches are INDEPENDENT: the absence branch never consults the
// bundle hash, and the deploy branch never consults the staleness threshold.
// They share only the check, the stamp and `deps.reload` — which is
// `bundleHash.performRefresh`, because a second reload path beside it would be
// a second consumer of the same SW/cache dance (the three-presses-to-update bug
// it exists to fix).
//
// The interval is measured from a PERSISTED stamp, never from in-memory state
// or a timer. That is the whole point: the document may have been frozen for
// the entire window with no JS running, so nothing in the page can have
// counted the hours. Only storage crosses the suspension.
//
// TWO STORES, on purpose:
//   * the stamp lives in sessionStorage — it means "when was THIS document
//     last alive", and sessionStorage is exactly per-window-lifetime: it
//     survives a reload and a suspension, and it does not leak between tabs.
//     In localStorage a foreground desktop tab would keep refreshing the
//     shared stamp and the suspended PWA — the degraded document this whole
//     feature exists for — would never trip.
//   * the threshold override lives in localStorage: device-wide operator
//     config that must outlive any one window.
//
// ONE RULE keeps "reload exactly once" true: every check stamps, and the
// stale ones also reload. Because the stamp is refreshed as the reload is
// requested, no later trigger in this document can see the same absence
// twice, and a reload that never lands (a blocked navigation, the e2e
// `__refreshProbe`) leaves the document healthy rather than wedged — a
// boolean latch would have disabled the feature for that document's whole
// remaining life. `installStaleResumeReload` also stamps BEFORE arming any
// trigger, so the document that just reloaded cannot immediately reload on
// the absence it was itself the answer to.
//
// THE #674 INVARIANT — the dwell verdict is judged on the gap AT THE RESUME.
//
// `bundle_hash` rides the user-topic JOIN, so on resume it lands a rejoin after
// the visibility transition that observed the absence. By then `check` has
// already refreshed the stamp and `now - lastActive` reads ~0, so a verdict
// re-derived at hash-arrival time would be false forever and the branch would
// never fire for its most common case — the operator deployed while you were
// away. `check` therefore READS the gap before `markActive` destroys it and
// carries it to the decision. The carry is not a parallel structure: the stamp
// overwrites the gap by construction, so this is its only surviving copy, it
// has exactly one writer, and every check overwrites it — which is also what
// closes the window, with no boolean latch to wedge the document.
//
// Withholding the stamp until the discriminant arrives was considered and
// REJECTED: it breaks #695's "every check stamps" rule (the absence branch
// would re-fire on every trigger), it couples a branch to a value it does not
// consume, and on a broken network — where `bundle_hash` never arrives at all —
// the stamp would never advance and the absence branch would loop.
//
// Thresholds: 48h for the absence (24h was considered and rejected as too
// eager), 10 minutes for the deploy dwell. TWO KNOBS, never derived from one
// another and never from the server's `@auto_away_debounce_ms`, which happens
// to start at the same 10 minutes but answers a different question ("should
// your peers be told you are away" vs "may I throw this document away"); #348
// may yet make the server one user-configurable. Both are overridable per
// device via localStorage so a number can be tuned without a deploy-shaped
// argument. An absent, non-numeric or non-positive override falls back to the
// default — a typo must never turn into "reload on every resume".

export const STALE_RESUME_STAMP_KEY = "cicchetto.lastActiveAt";
export const STALE_RESUME_HOURS_KEY = "cicchetto.staleResumeHours";
export const DEFAULT_STALE_RESUME_HOURS = 48;

export const BUNDLE_REFRESH_MINUTES_KEY = "cicchetto.bundleRefreshMinutes";
export const DEFAULT_BUNDLE_REFRESH_MINUTES = 10;

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

/**
 * A stored positive-number override, else `fallback`.
 *
 * Shared by both knobs so the "absent / non-numeric / non-positive → default"
 * posture cannot drift between them. It does NOT make one derive from the
 * other: they keep distinct keys, defaults and units.
 */
function positiveOverride(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// The `pageshow` seam. Narrow on purpose: `installStaleResumeReload` has no
// uninstall path (a real listener outlives its test), so unit tests pass a
// fake rather than the real window — the same shape #649 uses for the
// viewport resume triggers.
export interface ResumeWindowLike {
  addEventListener(event: "pageshow", handler: () => void): void;
}

/**
 * Which of the two independent branches asked for the reload.
 *
 * #775 — the composition root needs to tell them apart: an applied deploy
 * announces itself across the navigation, a document thrown away for age has
 * nothing to announce. Passing the reason keeps that knowledge here, where the
 * branch is decided, instead of adding a second reload verb beside the one
 * this module deliberately shares between both branches.
 */
export type ReloadReason = "absence" | "bundle";

export interface StaleResumeDeps {
  // The visibility SSOT (`documentVisibility.ts` — visibilitychange AND
  // window focus/blur). Consumed as a signal rather than re-registering
  // parallel listeners.
  isVisible: Accessor<boolean>;
  // #674 — does the running page differ from the deployed bundle?
  // `bundleHash.shouldShowRefreshBanner` in production. Injected rather than
  // imported so this module stays free of the bundle-hash singletons and
  // testable against a plain signal.
  bundleMismatch: Accessor<boolean>;
  now: () => number;
  reload: (reason: ReloadReason) => void;
  win: ResumeWindowLike;
}

/** The effective inactivity threshold in ms — the stored override, else 48h. */
export function staleResumeThresholdMs(): number {
  return positiveOverride(STALE_RESUME_HOURS_KEY, DEFAULT_STALE_RESUME_HOURS) * MS_PER_HOUR;
}

/** The effective deploy-refresh dwell in ms — the stored override, else 10min. */
export function bundleRefreshDwellMs(): number {
  return (
    positiveOverride(BUNDLE_REFRESH_MINUTES_KEY, DEFAULT_BUNDLE_REFRESH_MINUTES) * MS_PER_MINUTE
  );
}

/** Record that this document was alive at `now`. */
export function markActive(now: number): void {
  sessionStorage.setItem(STALE_RESUME_STAMP_KEY, String(now));
}

/** The persisted stamp, or null when absent or unparseable. */
export function readLastActive(): number | null {
  const raw = sessionStorage.getItem(STALE_RESUME_STAMP_KEY);
  if (raw === null) return null;
  const stamp = Number(raw);
  return Number.isFinite(stamp) ? stamp : null;
}

/**
 * Has the document been away long enough to be worth throwing away?
 *
 * Strictly greater than the threshold, and false with no stamp — a
 * first-ever boot has nothing to be stale against.
 */
export function isStaleResume(
  now: number,
  lastActive: number | null,
  thresholdMs: number,
): boolean {
  return lastActive !== null && now - lastActive > thresholdMs;
}

/**
 * Is a deploy worth applying without asking?
 *
 * Takes the already-measured gap rather than `(now, lastActive)` like its
 * sibling above — deliberately. This decision is reached when the mismatch
 * becomes knowable, which is AFTER the stamp was refreshed, so there is no
 * honest `now - lastActive` left to compute. See the #674 invariant in the
 * module header.
 *
 * Strictly greater than the dwell, and false without a mismatch however long
 * the absence.
 */
export function shouldAutoRefreshBundle(
  resumeGapMs: number,
  dwellMs: number,
  mismatch: boolean,
): boolean {
  return mismatch && resumeGapMs > dwellMs;
}

/**
 * Arm the stale-resume reload and return the check verb.
 *
 * Checks on every resume trigger: the visibility signal (tab switch,
 * app-switch, desktop focus) and `pageshow` (the bfcache/PWA restore whose
 * computed visibility never changed, so the signal never fires). The returned
 * verb is that SAME check, handed to the #318 foreground heartbeat by
 * `main.tsx` — on iOS the background transition frequently never fires at
 * all, and the first tick after a thaw is then the only trigger that can
 * observe the absence. Handing out the check rather than the stamp writer
 * keeps ONE writer of the stamp: a caller that stamped without checking would
 * erase the very evidence the feature runs on.
 *
 * Overlapping triggers are free: the check is idempotent once the stamp is
 * refreshed, exactly as #649 argues for its three viewport resume triggers.
 */
export function installStaleResumeReload(deps: StaleResumeDeps): () => void {
  // The gap this check observed, carried to the #674 decision because
  // `markActive` below is about to destroy it. Overwritten by every check, so
  // a foreground heartbeat tick closes the window on its own.
  const [resumeGapMs, setResumeGapMs] = createSignal(0);

  const check = (): void => {
    const now = deps.now();
    const lastActive = readLastActive();
    // READ before the stamp overwrites it — the #674 invariant. Clamped at 0
    // so a backwards clock step cannot manufacture an absence, mirroring
    // `isStaleResume`'s future-dated-stamp posture.
    setResumeGapMs(lastActive === null ? 0 : Math.max(0, now - lastActive));
    const stale = isStaleResume(now, lastActive, staleResumeThresholdMs());
    // Stamp FIRST, unconditionally: this is what makes the reload fire once
    // per absence rather than once per trigger.
    markActive(now);
    if (stale) deps.reload("absence");
  };

  // BEFORE arming anything — see the loop guard in the module header.
  markActive(deps.now());

  deps.win.addEventListener("pageshow", check);
  createEffect(() => {
    // Tracked: any visibility transition, in either direction. Going hidden
    // stamps the precise moment the operator left, which is a better
    // baseline than the last heartbeat tick.
    deps.isVisible();
    check();
  });

  // #674 — re-decided whenever EITHER input moves: the mismatch becoming known
  // after a long resume (the common case: deployed while you were away), or a
  // fresh long gap arriving while a mismatch was already known (the banner was
  // up, you left, you came back). Both are read unconditionally so Solid tracks
  // both every run — a short-circuit here would silently drop the second case.
  createEffect(() => {
    const mismatch = deps.bundleMismatch();
    const gap = resumeGapMs();
    if (shouldAutoRefreshBundle(gap, bundleRefreshDwellMs(), mismatch)) deps.reload("bundle");
  });

  return check;
}
