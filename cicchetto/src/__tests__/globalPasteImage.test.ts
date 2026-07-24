import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #352 — the IMAGE half of global paste, end-to-end through the REAL router.
// globalPaste.test.ts mocks lib/pasteRoute to assert the wiring; this file
// leaves pasteRoute + uploadCategory REAL and mocks only the leaf sinks, so a
// file paste that fires while the compose bar is unfocused is proven to reach
// the upload path (dropUpload) exactly as a focused textarea paste would. Closes
// the "text OR image" coverage gap: the e2e covers text, this covers image.

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));
vi.mock("../lib/compose", () => ({
  getDraft: vi.fn(() => ""),
  setDraft: vi.fn(),
}));
vi.mock("../lib/confirmDialog", () => ({ requestConfirm: vi.fn() }));
vi.mock("../lib/dropUpload", () => ({ dropUpload: vi.fn() }));
vi.mock("../lib/selection", () => ({
  selectedChannel: () => ({ networkSlug: "freenode", channelName: "#a", kind: "channel" }),
}));
vi.mock("../lib/overlayScrollLock", () => ({ overlayCount: () => 0 }));

import { dropUpload } from "../lib/dropUpload";
import { handleGlobalPaste } from "../lib/globalPaste";

function filePasteEvent(file: File): ClipboardEvent {
  const dt = {
    items: [{ kind: "file", type: file.type, getAsFile: () => file }],
    getData: () => "",
  };
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", { value: dt, configurable: true });
  return e as unknown as ClipboardEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  (document.activeElement as HTMLElement | null)?.blur?.();
  document.body.innerHTML = "";
});

describe("globalPaste — image paste (real router → upload)", () => {
  it("an unfocused image paste routes through to dropUpload for the active window", () => {
    const ta = document.createElement("textarea");
    ta.setAttribute("data-compose-input", "");
    document.body.appendChild(ta);
    // activeElement defaults to <body> — non-editable, so the handler acts.

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", {
      type: "image/png",
    });
    handleGlobalPaste(filePasteEvent(file));

    expect(dropUpload).toHaveBeenCalledWith([file], "freenode", "#a");
  });
});
