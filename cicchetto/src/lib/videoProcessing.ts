// issue 2157 — the device-local switch for cic's client-side video transcode.
//
// iOS re-encodes a clip on its way OUT of the Photos picker, so by the time
// `prepareVideo` sees the File the bytes have already been compressed once;
// cic's own transcode is a second pass over them, paid for in battery and
// wall-clock on the device least able to afford it. This switch turns that
// pass off.
//
// ## Default OFF (issue 2173, owner's ruling — it shipped ON under #2157)
//
// The cost is real and is paid rather than hidden: the transcode is the only
// client-side mechanism that shrinks an over-cap clip, so a desktop operator
// dragging a long screen capture now gets a REFUSAL where they used to get an
// upload. `uploadOrchestrator`'s cap refusal therefore names this switch by
// the label below (the issue's option A) — the recourse rides the only
// message the operator will see, because with the transcode off there is no
// "processing failed (reason)" line to carry it and on iOS Safari there is no
// console to read either.
//
// Option B — default OFF on iOS, ON elsewhere — was declined, and NOT for the
// reason the issue offered ("it costs a UA check the codebase avoids"):
// `platform.ts` already exports `isIos()`, so B would have cost one import.
// It was declined because it does not CURE the cost, it only narrows who pays
// it — and it narrows it away from the desktop and onto iOS, which is both
// the platform the switch was aimed at and the one with no console. A
// per-device default would also make "the default" two answers decided by a
// `maxTouchPoints` heuristic, which is exactly the kind of silent drift
// #1869/#2014 moved cic's other platform decisions off.
//
// ## Why localStorage and NOT the synced `displayPrefs` bundle
//
// The criterion is not invented here: #1766 fixed it and #2029 restated it —
// a pref is per-DEVICE when the complaint is about the device (#914's
// `hide_next_active`, a fixed overlay on a phone), and synced when it is about
// the ACCOUNT (#2029's `strip_formatting`: a channel full of coloured bot
// output looks the same everywhere). The double encode is a property of the
// iOS picker and of this device's CPU. Syncing the flag would carry "don't
// process" from the phone to the desktop browser, where the local transcode is
// the only thing that shrinks a 200MB screen capture to something the cap will
// accept — the switch would break the platform it was never aimed at.
//
// That also decides where the checkbox goes: it gets a fieldset of its own
// rather than joining the upload-retention one, because the toggle already
// there (`upload_confirm_enabled`) is account-synced, and #2029 named two
// adjacent checkboxes that persist differently as "a promise the interface
// should not break".
//
// ## Shape: fontSize.ts, not colorNicklist.ts
//
// No signal. `colorNicklist.ts` needs one because it is read inside a render
// path; this flag is read once per upload attempt inside `prepareVideo`, which
// is not reactive at all. The settings checkbox holds its own local signal the
// way the drawer already does for text size — the same reason `fontSize.ts` is
// a bare localStorage pair.

export const VIDEO_PROCESSING_STORAGE_KEY = "cicchetto.videoProcessing";

/**
 * The user-facing name of this switch, in ONE place because two surfaces
 * render it: the Settings checkbox, and the over-cap upload refusal that
 * tells the operator where to go (#2173 option A). Same shape and the same
 * reason as `SHARE_SESSION_LABEL` — a name spelled twice is a name that will
 * eventually disagree with itself, and here the disagreement would send
 * someone looking for a control that is not called that.
 */
export const VIDEO_PROCESSING_LABEL = "Shrink videos before sending";

const DEFAULT_ON = false;

/** Whether cic should transcode a video before uploading it. Device-local. */
export function getVideoProcessingEnabled(): boolean {
  // `v === "true"` — the OFF-default family (colorNicklist.ts, eventBadge.ts,
  // hideNextActive.ts), NOT the `v !== "false"` one (showBottomBar.ts) this
  // pref used while it defaulted ON. The two families differ only on values
  // that are neither literal, and that is the whole point: under the old
  // spelling every corrupt or unknown value read ON, which with the default
  // now OFF would be the opposite of the ruling, silently. Falling to the
  // default is the safe side in both directions here — an unrequested
  // transcode costs battery, and the refusal it would have avoided now names
  // the switch.
  const v = localStorage.getItem(VIDEO_PROCESSING_STORAGE_KEY);
  return v === null ? DEFAULT_ON : v === "true";
}

export function setVideoProcessingEnabled(on: boolean): void {
  localStorage.setItem(VIDEO_PROCESSING_STORAGE_KEY, on ? "true" : "false");
}
