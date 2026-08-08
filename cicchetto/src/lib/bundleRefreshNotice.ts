import { bootBundleHashAccessor, performRefresh, versionLabel } from "./bundleHash";
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
 * measure the navigation alone and allow a much tighter window. Still rejected,
 * though #1063 removed the original reason: the manual banner click DOES mark
 * now, so "one caller's benefit" no longer applies. What is left is that the
 * hook would move the write inside the shared SW verb for a tighter fence that
 * buys nothing — the HASH guard, not this one, is what proves something
 * actually changed. `requestBundleRefresh` marks around `performRefresh`
 * instead, which keeps the verb ignorant of the notice entirely.
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

/**
 * Who asked for the reload — the ONE thing the arriving document cannot
 * re-derive, and the whole reason #1063 extends this marker rather than
 * adding a second one.
 *
 * `"user"` is a human who pressed Refresh and is owed an answer either way.
 * `"auto"` is #674 applying a deploy nobody asked for: worth announcing when
 * it changed something, silence when it did not. `"silent"` never marks at
 * all — #695 throws a document away for AGE, and that has nothing to tell
 * anyone.
 */
export type BundleRefreshOrigin = "user" | "auto" | "silent";

/** The origins that actually reach storage; `"silent"` writes no marker. */
type MarkedOrigin = Exclude<BundleRefreshOrigin, "silent">;

/**
 * What the arriving document should say, if anything.
 *
 * `"unchanged"` is the case #1063 exists for and the only genuinely new one:
 * the reload ran, and the bundle underneath it did not move. Today that is
 * indistinguishable from "I did not press hard enough", because the identical
 * banner simply reappears.
 */
export type BundleRefreshOutcome = "changed" | "unchanged" | "none";

interface Marker {
  at: number;
  from: string | null;
  origin: MarkedOrigin;
}

/**
 * Record, at `now`, that a bundle refresh is being requested from the bundle
 * `fromHash`, by `origin`.
 *
 * The DEPARTING hash, not the target: a second deploy can land while the reload
 * is in flight, and "I am no longer on the bundle that asked to be replaced" is
 * true in that case too, where "I am on exactly the bundle we aimed at" is not.
 */
export function markBundleRefreshApplied(
  now: number,
  fromHash: string | null,
  origin: MarkedOrigin,
): void {
  const marker: Marker = { at: now, from: fromHash, origin };
  sessionStorage.setItem(BUNDLE_REFRESH_NOTICE_KEY, JSON.stringify(marker));
}

/**
 * Mark (unless silent) and then reload through the shared SW-aware verb.
 *
 * ONE writer of the marker, which is the point: before #1063 the composition
 * root wrote it and the two manual Refresh buttons did not, so pressing
 * Refresh was silent by omission rather than by decision. Adding the write to
 * each caller instead would have made three copies of the same two lines and
 * the next caller would have been the one that forgot.
 *
 * `performRefresh` itself is left alone deliberately: it is the shared SW +
 * cache verb, `bundleRefreshNotice` already depends on `bundleHash` for
 * `versionLabel`, and reversing that edge to push the marker down into it
 * would make the two modules mutually recursive for no gain.
 */
export async function requestBundleRefresh(
  now: number,
  fromHash: string | null,
  origin: BundleRefreshOrigin,
): Promise<void> {
  if (origin !== "silent") markBundleRefreshApplied(now, fromHash, origin);
  await performRefresh();
}

/** `requestBundleRefresh` with the boot hash the page is actually running. */
export function requestBundleRefreshNow(origin: BundleRefreshOrigin): Promise<void> {
  return requestBundleRefresh(Date.now(), bootBundleHashAccessor(), origin);
}

function readMarker(): Marker | null {
  const raw = sessionStorage.getItem(BUNDLE_REFRESH_NOTICE_KEY);
  if (raw === null) return null;
  // A storage boundary: anything at all can be in that slot (an older format, a
  // half-written value, an operator poking at devtools).
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { at, from, origin } = parsed as Partial<Marker>;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    if (from !== null && typeof from !== "string") return null;
    if (origin !== undefined && origin !== "user" && origin !== "auto") return null;
    // ACROSS THE DEPLOY THAT SHIPS #1063, the marker is written by the OLD
    // bundle and read by the NEW one, so the very first boot after this lands
    // reads a marker with no `origin` at all. Before #1063 the only writer was
    // the #674 deploy branch, so that is what an absent field means — anything
    // else would drop #775's toast on exactly the deploy that introduces it.
    return { at, from, origin: origin ?? "auto" };
  } catch {
    return null;
  }
}

/**
 * Read the marker and clear it, and say what this boot may truthfully claim.
 *
 * Always clears — an unusable marker (absent, corrupt, too old, future-dated by
 * a backwards clock step) must not survive to be re-judged by a later boot.
 *
 * `"unchanged"` is #1063's addition and it is gated on `origin === "user"`. A
 * reload nobody asked for that changed nothing is a non-event and stays silent,
 * exactly as #674 and #695 ship today; a reload a HUMAN asked for that changed
 * nothing is the whole complaint — the page comes back identical, the banner
 * reappears, and "it did not work" is indistinguishable from "I mis-tapped".
 */
export function consumeBundleRefreshNotice(
  now: number,
  bootHash: string | null,
): BundleRefreshOutcome {
  const marker = readMarker();
  sessionStorage.removeItem(BUNDLE_REFRESH_NOTICE_KEY);
  if (marker === null) return "none";
  const elapsed = now - marker.at;
  if (elapsed < 0 || elapsed > BUNDLE_REFRESH_NOTICE_WINDOW_MS) return "none";
  // Unknown on either side is not proof of anything, and either announcement is
  // a claim. Silence rather than a guess, the same posture
  // `shouldShowRefreshBanner` takes.
  if (marker.from === null || bootHash === null) return "none";
  if (bootHash !== marker.from) return "changed";
  return marker.origin === "user" ? "unchanged" : "none";
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
 * The toast for a refresh that ran and moved nothing.
 *
 * DELIBERATELY DOES NOT DIAGNOSE. "The update did not apply" would be a lie
 * whenever there was nothing to apply — the operator can press Refresh with no
 * deploy waiting (the boot-error recovery button does exactly that) — and this
 * document cannot tell the two apart: `bundle_hash` is a server push that has
 * not landed yet when `Toasts` mounts. What it CAN say is what it is running,
 * which is the fact the operator is missing. Read next to the banner, which
 * reappears only in the failed case, it separates them without guessing.
 */
export function formatBundleUnchangedToast(version: string | null, hash: string | null): string {
  return `Still on ${versionLabel(version, hash)}`;
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
  switch (consumeBundleRefreshNotice(now, bootHash)) {
    case "changed":
      queue.queue({ text: formatBundleRefreshToast(version, bootHash) });
      return;
    case "unchanged":
      queue.queue({ text: formatBundleUnchangedToast(version, bootHash) });
      return;
    case "none":
      return;
  }
}
