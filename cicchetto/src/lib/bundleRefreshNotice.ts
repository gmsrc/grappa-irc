import { versionLabel } from "./bundleHash";
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
// TWO GUARDS, because there are two ways to lie and neither predicate covers
// the other:
//
//   * TIME — "is this boot the one we asked for?" A reload lands within seconds
//     of being requested or it does not land at all, so a marker older than the
//     window below is not evidence of anything. This is what stops a manual
//     reload an hour later from announcing an auto-refresh that never happened.
//   * HASH — "did the bundle actually change?" The marker carries the hash the
//     DEPARTING document was running; the arriving one announces only if it
//     booted on something else. This is not hypothetical: `performRefresh`'s own
//     header documents reloads that keep serving the OLD precached index.html
//     (the three-presses-to-update bug it exists to mitigate), and such a reload
//     lands well inside the time window, on the same bytes, with nothing to
//     announce. An earlier draft of this module called the hash guard "strictly
//     weaker" than time and shipped without it — wrong, and this is the case it
//     missed.
//
// Read-and-clear happens on every path, so an unusable marker cannot resurface.
// A hash unknown on either side is silence, not a guess — the same posture
// `shouldShowRefreshBanner` takes, and no honest case is lost by it: the branch
// that writes the marker only fires when both hashes are known and differ.
//
// Two consequences, both deliberate: a document iOS suspends mid-navigation and
// thaws an hour later drops the toast (silence, which is what #674 shipped
// anyway, and never a false announcement), and a boot is never told the VERSION
// it came from — it reads the version it is now running off the page.
//
// sessionStorage, like #695's stamp and for the same reason: it is scoped to
// THIS window's lifetime and survives a reload, where localStorage would hand
// the marker to every tab on the device. It is not a hard partition — a
// browser-level "Duplicate Tab" CLONES sessionStorage into the new context, so
// a duplicate made between the request and the navigation inherits a live
// marker. The hash guard covers that one: the duplicate boots on whatever the
// original was running unless the deploy genuinely reached it.

export const BUNDLE_REFRESH_NOTICE_KEY = "cicchetto.bundleRefreshAt";

/**
 * How long the marker is evidence that the reload landed.
 *
 * Sized for the whole chain, not the navigation: the marker is written when the
 * branch DECIDES, and `performRefresh` then awaits an unbounded
 * `registration.update()`, up to 2s for `controllerchange`, and a full cache
 * purge before it navigates at all — after which the boot it purged the caches
 * for fetches everything over the same link that was slow enough to need the
 * refresh. A minute is comfortably inside that on a degraded mobile connection,
 * and a legitimate refresh that drops its toast is the failure this number
 * exists to avoid.
 *
 * Marking later — a `beforeReload` hook in `performRefresh`'s `finally` — would
 * measure the navigation alone and allow a much tighter window. Rejected for
 * now: `performRefresh` is shared with the manual banner click, which must not
 * mark, so the hook would put a parameter on a shared verb for one caller's
 * benefit. Five minutes is the cheaper answer while the HASH guard, not this
 * one, is what proves something actually changed.
 */
export const BUNDLE_REFRESH_NOTICE_WINDOW_MS = 300_000;

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

interface Marker {
  at: number;
  from: string | null;
}

/**
 * Record, at `now`, that a bundle auto-refresh is being requested from the
 * bundle `fromHash`.
 *
 * The DEPARTING hash, not the target: a second deploy can land while the reload
 * is in flight, and "I am no longer on the bundle that asked to be replaced" is
 * true in that case too, where "I am on exactly the bundle we aimed at" is not.
 */
export function markBundleRefreshApplied(now: number, fromHash: string | null): void {
  const marker: Marker = { at: now, from: fromHash };
  sessionStorage.setItem(BUNDLE_REFRESH_NOTICE_KEY, JSON.stringify(marker));
}

function readMarker(): Marker | null {
  const raw = sessionStorage.getItem(BUNDLE_REFRESH_NOTICE_KEY);
  if (raw === null) return null;
  // A storage boundary: anything at all can be in that slot (an older format, a
  // half-written value, an operator poking at devtools).
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { at, from } = parsed as Partial<Marker>;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    if (from !== null && typeof from !== "string") return null;
    return { at, from };
  } catch {
    return null;
  }
}

/**
 * Read the marker and clear it: true iff this boot is the one it was written
 * for AND it booted on a different bundle.
 *
 * Always clears — an unusable marker (absent, corrupt, too old, future-dated by
 * a backwards clock step, or answered by a reload that changed nothing) must not
 * survive to be re-judged by a later boot.
 */
export function consumeBundleRefreshNotice(now: number, bootHash: string | null): boolean {
  const marker = readMarker();
  sessionStorage.removeItem(BUNDLE_REFRESH_NOTICE_KEY);
  if (marker === null) return false;
  const elapsed = now - marker.at;
  if (elapsed < 0 || elapsed > BUNDLE_REFRESH_NOTICE_WINDOW_MS) return false;
  // Unknown on either side is not proof of a change, and an announcement is a
  // claim. Costs no honest case: the branch that writes the marker only fires
  // when both hashes are known and differ.
  if (marker.from === null || bootHash === null) return false;
  return bootHash !== marker.from;
}

/**
 * The toast text for the bundle now running; pure, so it is worth reading.
 *
 * Labelled through #292's `versionLabel`, which exists because a bundle-only
 * rebuild reuses the semver: without the hash suffix "Updated to 0.10.0" is
 * indistinguishable from "nothing happened" for exactly the trivial rebuild
 * that most often triggers this.
 */
export function formatBundleRefreshToast(version: string | null, hash: string | null): string {
  return `Updated to ${versionLabel(version, hash)}`;
}

/**
 * Announce the refresh, if this boot is the one it landed in.
 *
 * The bundle identity is passed rather than read from `bundleHash` so this
 * module stays free of those singletons — same posture as `staleResume`'s
 * injected deps, and it is what lets the guard be tested against both bundles
 * instead of whatever the test page happens to have booted.
 */
export function announceAppliedBundleRefresh(
  now: number,
  bootHash: string | null,
  version: string | null,
): void {
  if (!consumeBundleRefreshNotice(now, bootHash)) return;
  queue.queue({ text: formatBundleRefreshToast(version, bootHash) });
}
