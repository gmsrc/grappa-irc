import { createToastQueue } from "./toasts";

// #775 — announcing an auto-refresh (#674) that actually landed.
//
// #674 applies a deploy while nobody is looking: on a resume whose gap says the
// operator was away, the page reloads itself onto the new bundle. It ships
// SILENT, and coming back to a client that visibly reset with no explanation is
// its own small mystery. One auto-dismissing toast closes it. Not a banner —
// something the operator has to close is the annoyance the auto-refresh exists
// to remove (vjt, #775).
//
// THE HARD PART IS NOT THE SURFACE — it is that the announcement outlives the
// document that decided to make it. The refresh throws this page away, so the
// notice is written to storage before the reload is requested and read back by
// the document that boots next.
//
// STRANDING is the failure mode that shape invites. `deps.reload` is a request,
// not a guarantee: the navigation can be blocked, the e2e `__refreshProbe`
// replaces it outright, the operator can kill the tab. The marker then survives
// in a document that never refreshed, and the next boot of that window — an
// hour later, for its own reasons — would announce an auto-refresh that never
// happened.
//
// The guard is TIME, because time is what actually separates the two cases: a
// reload lands within seconds of being asked for, or it does not land at all.
// A marker older than the window below is therefore not evidence of anything
// and is discarded — read-and-clear happens either way, so it cannot resurface.
// Two consequences, both deliberate: a document iOS suspends mid-navigation and
// thaws an hour later drops the toast (silence, which is what #674 shipped
// anyway, and never a false announcement), and a boot is never told the version
// it came from — it reads the version it is now running off the page.
//
// sessionStorage, like #695's stamp and for the same reason: it is scoped to
// THIS window's lifetime and survives a reload. In localStorage a second tab
// would announce a refresh it never performed.

export const BUNDLE_REFRESH_NOTICE_KEY = "cicchetto.bundleRefreshAt";

/**
 * How long the marker is evidence that the reload landed.
 *
 * Generous against a slow PWA cold start (the refresh purges the caches first,
 * so the next navigate goes to the network), and far below any human-scale
 * "I reloaded this tab later for unrelated reasons".
 */
export const BUNDLE_REFRESH_NOTICE_WINDOW_MS = 60_000;

interface BundleRefreshToast {
  text: string;
}

// NOT identity-scoped, unlike #247's queue: a bundle is a property of the
// device and the deploy, not of who is logged in. See toasts.ts on why that
// difference is what made a second queue the right call over a `bundle`
// variant of `PresenceToast`.
const queue = createToastQueue<BundleRefreshToast>();

export const bundleRefreshToasts = queue.toasts;
export const dismissBundleRefreshToast = queue.dismiss;

/** Record, at `now`, that a bundle auto-refresh is being requested. */
export function markBundleRefreshApplied(now: number): void {
  sessionStorage.setItem(BUNDLE_REFRESH_NOTICE_KEY, String(now));
}

/**
 * Read the marker and clear it: true iff this boot is the one it was written
 * for.
 *
 * Always clears — an unusable marker (absent, corrupt, too old, future-dated by
 * a backwards clock step) must not survive to be re-judged by a later boot.
 */
export function consumeBundleRefreshNotice(now: number): boolean {
  const raw = sessionStorage.getItem(BUNDLE_REFRESH_NOTICE_KEY);
  sessionStorage.removeItem(BUNDLE_REFRESH_NOTICE_KEY);
  if (raw === null) return false;
  const at = Number(raw);
  if (!Number.isFinite(at)) return false;
  const elapsed = now - at;
  return elapsed >= 0 && elapsed <= BUNDLE_REFRESH_NOTICE_WINDOW_MS;
}

/** The toast text for the version now running; pure, so it is worth reading. */
export function formatBundleRefreshToast(version: string | null): string {
  return version !== null ? `Updated to ${version}` : "Updated to the latest version";
}

/**
 * Announce the refresh, if this boot is the one it landed in.
 *
 * `version` is passed rather than read from `bundleHash` so this module stays
 * free of those singletons — same posture as `staleResume`'s injected deps.
 */
export function announceAppliedBundleRefresh(now: number, version: string | null): void {
  if (!consumeBundleRefreshNotice(now)) return;
  queue.queue({ text: formatBundleRefreshToast(version) });
}
