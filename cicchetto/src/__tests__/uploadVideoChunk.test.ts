import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// issue 2157 — "with the switch off the mediabunny chunk is never fetched" is
// HALF the win on a phone (534 kB parsed / 133 kB gzipped, measured on
// `bun run build` 2026-09-14), and it is a claim about the dynamic `import()`,
// not about `transcodeVideo` going uncalled. A test that only asserts the
// function was not called passes just as happily when the chunk was downloaded
// and then ignored.
//
// So this file measures the IMPORT, and it needs its own file to do it. A
// `vi.mock` factory runs exactly ONCE per module registry — on the first
// `import()` of the mocked module — so a counter incremented inside it is only
// readable while the registry is still cold. In uploadOrchestrator.test.ts
// thirty other tests have already warmed it; here nothing has. Vitest isolates
// the module registry per test FILE, which is what makes the count meaningful.
//
// The two tests below are ONE measurement in two halves and must stay in this
// order: the OFF case reads the counter while it can still be zero, and the ON
// case is the positive control that proves the counter moves at all. Without
// the second, `0` in the first would be indistinguishable from a counter that
// is simply broken.

const chunk = vi.hoisted(() => ({ factoryRuns: 0 }));

vi.mock("../lib/scrollback", () => ({ sendMessage: vi.fn(async () => {}) }));

vi.mock("../lib/userSettings", async () => {
  const actual = await vi.importActual<typeof import("../lib/userSettings")>("../lib/userSettings");
  return {
    ...actual,
    getUploadTtlSeconds: vi.fn(async () => null),
    putUploadTtlSeconds: vi.fn(async (_t: string, s: number | null) => s),
    getUploadConfirmEnabled: vi.fn(async () => false),
    putUploadConfirmEnabled: vi.fn(async (_t: string, e: boolean) => e),
  };
});

// The instrument. Incrementing in the factory body — not in `transcodeVideo` —
// is the whole point: this counts the module being LOADED, which is what the
// network fetch of the lazy chunk corresponds to.
vi.mock("../lib/videoTranscode", () => {
  chunk.factoryRuns += 1;
  return {
    transcodeVideo: vi.fn(async (file: File) => ({ ok: file })),
  };
});

import { channelKey } from "../lib/channelKey";
import { acceptConfirm } from "../lib/confirmDialog";
import { activeHost, type UploadHost } from "../lib/uploadHost";
import { resetUploadsForTests, triggerUpload, uploadState } from "../lib/uploadOrchestrator";
import { __setProbeDurationForTests } from "../lib/videoPolicy";
import { setVideoProcessingEnabled } from "../lib/videoProcessing";

vi.mock("../lib/uploadHost", async () => {
  const actual = await vi.importActual<typeof import("../lib/uploadHost")>("../lib/uploadHost");
  return { ...actual, activeHost: vi.fn(() => actual.embeddedHost) };
});

const slug = "azzurra";
const channel = "#a";
const key = channelKey(slug, channel);

let uploaded: File[] = [];

const videoHost = (): UploadHost => ({
  id: "chunk-test-host",
  displayName: "chunk.test",
  retentionStatement: "TEST host.",
  ttlOptions: [],
  defaultTtl: null,
  acceptedMimeTypes: { image: [], video: ["video/mp4"], document: [], audio: [] },
  maxFileSizeBytes: () => 5 * 1024 * 1024,
  supportsProgress: true,
  upload: async (file) => {
    uploaded.push(file);
    return "https://example.invalid/clip.mp4";
  },
});

const clip = (): File => new File([new Uint8Array(16)], "clip.mp4", { type: "video/mp4" });

const sendClip = async (): Promise<void> => {
  triggerUpload(key, slug, channel, clip());
  acceptConfirm();
  // The upload settles through the host promise; wait for the entry to clear
  // or for an error to land, whichever the run produces.
  await vi.waitFor(() => expect(uploaded.length + (uploadState(key)?.error ? 1 : 0)).toBe(1));
};

beforeEach(() => {
  uploaded = [];
  localStorage.clear();
  localStorage.setItem("image-upload-privacy-acknowledged:chunk-test-host", "1");
  resetUploadsForTests();
  vi.mocked(activeHost).mockReturnValue(videoHost());
  __setProbeDurationForTests(async () => 10);
});

afterEach(() => {
  __setProbeDurationForTests(null);
});

describe("issue 2157 — the lazy mediabunny chunk", () => {
  it("is NEVER loaded when video processing is off (the import is short-circuited)", async () => {
    setVideoProcessingEnabled(false);

    await sendClip();

    expect(chunk.factoryRuns).toBe(0);
    expect(uploaded).toHaveLength(1);
  });

  // POSITIVE CONTROL for the test above. Same flow, switch on: the counter
  // MUST move, or the zero it reported a moment ago measured nothing.
  it("IS loaded when video processing is on (positive control for the counter)", async () => {
    setVideoProcessingEnabled(true);

    await sendClip();

    expect(chunk.factoryRuns).toBe(1);
    expect(uploaded).toHaveLength(1);
  });
});
