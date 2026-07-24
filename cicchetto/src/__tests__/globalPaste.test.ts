import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #352 — boot-time document-level paste listener. When Ctrl/Cmd+V fires while
// focus is OFF the compose textarea (scrollback, body, a just-closed menu), the
// listener focuses the compose bar and routes the payload through the SAME
// shared router the textarea's own onPaste uses (lib/pasteRoute). It must NOT
// hijack a paste that a different editable field (search, settings) owns, nor
// steal one while a modal overlay is open.

vi.mock("../lib/pasteRoute", () => ({
  routeClipboardPaste: vi.fn(),
}));

let mockSelection: { networkSlug: string; channelName: string; kind: string } | null = {
  networkSlug: "freenode",
  channelName: "#a",
  kind: "channel",
};
vi.mock("../lib/selection", () => ({
  selectedChannel: () => mockSelection,
}));

let mockOverlayCount = 0;
vi.mock("../lib/overlayScrollLock", () => ({
  overlayCount: () => mockOverlayCount,
}));

import { handleGlobalPaste, installGlobalPaste, isEditableTarget } from "../lib/globalPaste";
import { routeClipboardPaste } from "../lib/pasteRoute";

function fakePasteEvent(): ClipboardEvent {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  const dt = { items: [], getData: () => "" };
  Object.defineProperty(e, "clipboardData", { value: dt, configurable: true });
  return e as unknown as ClipboardEvent;
}

function addComposeTextarea(): HTMLTextAreaElement {
  const ta = document.createElement("textarea");
  ta.setAttribute("data-compose-input", "");
  document.body.appendChild(ta);
  return ta;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelection = { networkSlug: "freenode", channelName: "#a", kind: "channel" };
  mockOverlayCount = 0;
});

afterEach(() => {
  (document.activeElement as HTMLElement | null)?.blur?.();
  document.body.innerHTML = "";
});

describe("globalPaste — isEditableTarget", () => {
  it("is true for input + textarea, false for a plain element or null", () => {
    expect(isEditableTarget(document.createElement("input"))).toBe(true);
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it("is true for a contentEditable element", () => {
    const div = document.createElement("div");
    Object.defineProperty(div, "isContentEditable", { value: true, configurable: true });
    expect(isEditableTarget(div)).toBe(true);
  });
});

describe("globalPaste — handleGlobalPaste", () => {
  it("unfocused paste → focuses the compose textarea + routes with nativeInsertAvailable=false", () => {
    const ta = addComposeTextarea();
    const focusSpy = vi.spyOn(ta, "focus");
    // activeElement defaults to <body> (non-editable) after the reset.

    handleGlobalPaste(fakePasteEvent());

    expect(focusSpy).toHaveBeenCalled();
    expect(routeClipboardPaste).toHaveBeenCalledTimes(1);
    expect(routeClipboardPaste).toHaveBeenCalledWith(
      expect.anything(),
      ta,
      "freenode",
      "#a",
      false,
    );
  });

  it("does NOT hijack when a different editable field owns focus", () => {
    addComposeTextarea();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    handleGlobalPaste(fakePasteEvent());

    expect(routeClipboardPaste).not.toHaveBeenCalled();
  });

  it("does NOT double-handle when the compose textarea itself owns focus (its onPaste runs)", () => {
    const ta = addComposeTextarea();
    ta.focus();

    handleGlobalPaste(fakePasteEvent());

    expect(routeClipboardPaste).not.toHaveBeenCalled();
  });

  it("does NOT hijack while a modal overlay is open", () => {
    addComposeTextarea();
    mockOverlayCount = 1;

    handleGlobalPaste(fakePasteEvent());

    expect(routeClipboardPaste).not.toHaveBeenCalled();
  });

  it("is a no-op (no throw) when no compose surface is mounted", () => {
    // no textarea in the DOM (home / mentions / admin / no selection)
    expect(() => handleGlobalPaste(fakePasteEvent())).not.toThrow();
    expect(routeClipboardPaste).not.toHaveBeenCalled();
  });

  it("is a no-op when there is no selected channel", () => {
    addComposeTextarea();
    mockSelection = null;

    handleGlobalPaste(fakePasteEvent());

    expect(routeClipboardPaste).not.toHaveBeenCalled();
  });
});

describe("globalPaste — installGlobalPaste", () => {
  it("wires a document paste listener that runs the handler", () => {
    const ta = addComposeTextarea();
    const focusSpy = vi.spyOn(ta, "focus");
    installGlobalPaste(document);

    document.body.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));

    expect(focusSpy).toHaveBeenCalled();
    expect(routeClipboardPaste).toHaveBeenCalledTimes(1);
  });
});
