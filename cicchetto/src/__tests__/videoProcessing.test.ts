import { beforeEach, describe, expect, it } from "vitest";

import {
  getVideoProcessingEnabled,
  setVideoProcessingEnabled,
  VIDEO_PROCESSING_STORAGE_KEY,
} from "../lib/videoProcessing";

// issue 2157 — the device-local switch for cic's client-side video transcode.
//
// Default ON is load-bearing: the transcode is the only thing that shrinks an
// over-cap clip to fit, so a browser that has never been told otherwise must
// keep doing it. The three tests below are the whole contract; the ORCHESTRATOR
// consequences (no transcodeVideo call, no lazy-chunk fetch, the duration
// ceiling still binding) live in uploadOrchestrator.test.ts and
// uploadVideoChunk.test.ts.

describe("videoProcessing (issue 2157 — device-local switch)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults ON when the key was never written", () => {
    expect(getVideoProcessingEnabled()).toBe(true);
  });

  it("round-trips through localStorage under the cic-namespaced key", () => {
    setVideoProcessingEnabled(false);
    expect(localStorage.getItem(VIDEO_PROCESSING_STORAGE_KEY)).toBe("false");
    expect(getVideoProcessingEnabled()).toBe(false);

    setVideoProcessingEnabled(true);
    expect(localStorage.getItem(VIDEO_PROCESSING_STORAGE_KEY)).toBe("true");
    expect(getVideoProcessingEnabled()).toBe(true);
  });

  // The read is deliberately NOT `stored === "true"` — the shape colorNicklist
  // uses. That shape is right for an OFF-default pref, where garbage falling to
  // `false` lands on the default anyway. Here the default is ON, so the same
  // spelling would let a corrupt value silently DISABLE the only mechanism that
  // shrinks an over-cap clip. Only the exact string "false" turns it off.
  it("a corrupt stored value falls back to the default (ON), never to OFF", () => {
    localStorage.setItem(VIDEO_PROCESSING_STORAGE_KEY, "yes-please");
    expect(getVideoProcessingEnabled()).toBe(true);

    localStorage.setItem(VIDEO_PROCESSING_STORAGE_KEY, "");
    expect(getVideoProcessingEnabled()).toBe(true);
  });
});
