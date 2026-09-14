import { beforeEach, describe, expect, it } from "vitest";

import {
  getVideoProcessingEnabled,
  setVideoProcessingEnabled,
  VIDEO_PROCESSING_STORAGE_KEY,
} from "../lib/videoProcessing";

// issue 2157 — the device-local switch for cic's client-side video transcode.
// issue 2173 — the default moved ON → OFF (owner's ruling), and the READ
// spelling moved with it, from the `v !== "false"` family (showBottomBar.ts)
// to the `v === "true"` family (colorNicklist.ts / eventBadge.ts /
// hideNextActive.ts). The two are not interchangeable: they disagree on every
// value that is neither "true" nor "false", and that disagreement is the
// difference between "a corrupt value transcodes" and "a corrupt value does
// not". The ORCHESTRATOR consequences (no transcodeVideo call, no lazy-chunk
// fetch, the duration ceiling still binding, the over-cap copy) live in
// uploadOrchestrator.test.ts and uploadVideoChunk.test.ts.

describe("videoProcessing (issue 2157 — device-local switch)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults OFF when the key was never written (issue 2173)", () => {
    expect(getVideoProcessingEnabled()).toBe(false);
  });

  it("round-trips through localStorage under the cic-namespaced key", () => {
    setVideoProcessingEnabled(true);
    expect(localStorage.getItem(VIDEO_PROCESSING_STORAGE_KEY)).toBe("true");
    expect(getVideoProcessingEnabled()).toBe(true);

    setVideoProcessingEnabled(false);
    expect(localStorage.getItem(VIDEO_PROCESSING_STORAGE_KEY)).toBe("false");
    expect(getVideoProcessingEnabled()).toBe(false);
  });

  // THE discriminating test for the new spelling, and the one the old code
  // would fail. With the default OFF the thing that must not happen is a
  // value nobody deliberately wrote turning the transcode ON — and that is
  // exactly what the previous reader (`stored === "false" ? false :
  // DEFAULT_ON`) and the showBottomBar-family mutant (`v !== "false"`) both
  // do: every string below is "not false", so both answer ON.
  //
  // "TRUE" is in the list on purpose: it kills a case-insensitive mutant,
  // which no other case here would.
  it('a value that is not the literal "true" reads OFF, never ON', () => {
    for (const corrupt of ["yes-please", "", "1", "TRUE", "on", "null"]) {
      localStorage.setItem(VIDEO_PROCESSING_STORAGE_KEY, corrupt);
      expect(getVideoProcessingEnabled()).toBe(false);
    }
  });
});
