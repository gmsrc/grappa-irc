// issue 2157 — the device-local switch for cic's client-side video transcode.
//
// iOS re-encodes a clip on its way OUT of the Photos picker, so by the time
// `prepareVideo` sees the File the bytes have already been compressed once;
// cic's own transcode is a second pass over them, paid for in battery and
// wall-clock on the device least able to afford it. This switch turns that
// pass off. Default ON — today's behaviour for every browser that has never
// been told otherwise.
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

const DEFAULT_ON = true;

/** Whether cic should transcode a video before uploading it. Device-local. */
export function getVideoProcessingEnabled(): boolean {
  // Deliberately NOT `stored === "true"`, the spelling colorNicklist.ts uses.
  // That one is right for an OFF-default pref, where an unparseable value
  // lands on the default anyway. This pref defaults ON, so the same spelling
  // would let a corrupt value silently disable the only mechanism that shrinks
  // an over-cap clip — a failure that presents as "Grappa suddenly refuses my
  // videos" with nothing in the UI to explain it. Only the exact string
  // "false" turns it off; everything else is the default.
  const stored = localStorage.getItem(VIDEO_PROCESSING_STORAGE_KEY);
  return stored === "false" ? false : DEFAULT_ON;
}

export function setVideoProcessingEnabled(on: boolean): void {
  localStorage.setItem(VIDEO_PROCESSING_STORAGE_KEY, on ? "true" : "false");
}
