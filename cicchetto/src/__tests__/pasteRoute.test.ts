import { beforeEach, describe, expect, it, vi } from "vitest";

// pasteRoute is the shared clipboard-paste router (extracted from ComposeBox,
// #352). ComposeBox.test.tsx already exercises the focused path end-to-end via
// the component; these tests pin the module's contract directly — in particular
// the `nativeInsertAvailable` flag that splits the focused textarea (browser
// inserts natively) from the #352 global path (paste fired unfocused → NO
// native insert → we insert explicitly).

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

vi.mock("../lib/compose", () => ({
  getDraft: vi.fn(() => ""),
  setDraft: vi.fn(),
}));

vi.mock("../lib/confirmDialog", () => ({
  requestConfirm: vi.fn(),
}));

vi.mock("../lib/dropUpload", () => ({
  dropUpload: vi.fn(),
}));

import { setDraft } from "../lib/compose";
import { requestConfirm } from "../lib/confirmDialog";
import { dropUpload } from "../lib/dropUpload";
import { routeClipboardPaste } from "../lib/pasteRoute";

type ClipItem = { kind: string; type: string; getAsFile: () => File | null };

// Synthesise a paste ClipboardEvent — jsdom ships no constructible
// ClipboardEvent that takes a clipboardData option (see ComposeBox.test.tsx),
// so build a plain Event + a structural DataTransfer with getData + items.
function pasteEvent(opts: { text?: string; file?: File | null }): {
  e: ClipboardEvent;
  preventDefault: ReturnType<typeof vi.spyOn>;
} {
  const items: ClipItem[] = [];
  if (opts.file) {
    items.push({ kind: "file", type: opts.file.type, getAsFile: () => opts.file ?? null });
  }
  const dt = {
    items,
    getData: (t: string) => (t === "text" || t === "text/plain" ? (opts.text ?? "") : ""),
  };
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", { value: dt, configurable: true });
  const preventDefault = vi.spyOn(e, "preventDefault");
  return { e: e as unknown as ClipboardEvent, preventDefault };
}

function textarea(): HTMLTextAreaElement {
  return document.createElement("textarea");
}

const pngFile = (): File =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });

describe("pasteRoute — routeClipboardPaste", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("file paste → dropUpload + preventDefault, no text insert", () => {
    const file = pngFile();
    const { e, preventDefault } = pasteEvent({ file });
    routeClipboardPaste(e, textarea(), "freenode", "#a", true);
    expect(dropUpload).toHaveBeenCalledWith([file], "freenode", "#a");
    expect(preventDefault).toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
  });

  it("small text, native insert AVAILABLE → left to the browser (no insert, no preventDefault)", () => {
    const { e, preventDefault } = pasteEvent({ text: "one line" });
    routeClipboardPaste(e, textarea(), "freenode", "#a", true);
    expect(setDraft).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(requestConfirm).not.toHaveBeenCalled();
  });

  it("small text, native insert UNAVAILABLE (global path) → explicit insert + preventDefault", () => {
    const { e, preventDefault } = pasteEvent({ text: "one line" });
    routeClipboardPaste(e, textarea(), "freenode", "#a", false);
    expect(setDraft).toHaveBeenCalledWith("freenode #a", "one line");
    expect(preventDefault).toHaveBeenCalled();
    expect(requestConfirm).not.toHaveBeenCalled();
  });

  it("empty text, native insert UNAVAILABLE → focus-only no-op (no insert, no preventDefault)", () => {
    const { e, preventDefault } = pasteEvent({ text: "" });
    routeClipboardPaste(e, textarea(), "freenode", "#a", false);
    expect(setDraft).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("big text (> flood threshold) → confirm dialog, no immediate insert (both modes)", () => {
    const block = "a\nb\nc\nd";
    for (const native of [true, false]) {
      vi.clearAllMocks();
      const { e, preventDefault } = pasteEvent({ text: block });
      routeClipboardPaste(e, textarea(), "freenode", "#a", native);
      expect(requestConfirm).toHaveBeenCalledTimes(1);
      expect(preventDefault).toHaveBeenCalled();
      expect(setDraft).not.toHaveBeenCalled();
    }
  });

  it("big text confirm → onConfirm inserts the block at the caret", () => {
    const block = "a\nb\nc\nd";
    const { e } = pasteEvent({ text: block });
    routeClipboardPaste(e, textarea(), "freenode", "#a", false);
    const req = vi.mocked(requestConfirm).mock.calls[0]?.[0];
    expect(req).toBeDefined();
    req?.onConfirm();
    expect(setDraft).toHaveBeenCalledWith("freenode #a", block);
  });
});
