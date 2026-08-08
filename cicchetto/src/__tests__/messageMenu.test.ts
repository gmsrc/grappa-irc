// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import {
  closeMessageMenu,
  copyMessageRow,
  copyToasts,
  dismissCopyToast,
  messageMenu,
  openMessageMenu,
  SELECTING_CLASS,
  selectMessageText,
} from "../lib/messageMenu";

// #1067 — the long-press message menu's store and its two DOM verbs. Reply is
// not here: it is `lib/replyQuote`, shared with the swipe.

function scrollbackRow(text: string): HTMLElement {
  const pane = document.createElement("div");
  pane.className = "scrollback";
  const row = document.createElement("div");
  row.className = "scrollback-line";
  row.textContent = text;
  pane.appendChild(row);
  document.body.appendChild(pane);
  return row;
}

function msg(): ScrollbackMessage {
  return {
    id: 7,
    network: "azzurra",
    channel: "#grappa",
    server_time: 1_700_000_000_000,
    kind: "privmsg",
    sender: "vjt",
    body: "ciao",
    meta: {},
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
  closeMessageMenu();
  for (const t of copyToasts()) dismissCopyToast(t.id);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("messageMenu store", () => {
  it("is closed until a long-press opens it, and carries the target", () => {
    expect(messageMenu()).toBeNull();
    const row = scrollbackRow("12:34 <vjt> ciao");
    openMessageMenu({
      msg: msg(),
      row,
      networkSlug: "azzurra",
      channelName: "#grappa",
      at: { x: 10, y: 20 },
    });
    expect(messageMenu()?.row).toBe(row);
    expect(messageMenu()?.at).toEqual({ x: 10, y: 20 });
    closeMessageMenu();
    expect(messageMenu()).toBeNull();
  });
});

describe("copyMessageRow", () => {
  function stubClipboard(): Mock<(t: string) => Promise<void>> {
    const writeText = vi.fn<(t: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    return writeText;
  }

  it("writes the whole rendered row — timestamp, sender and body", async () => {
    const writeText = stubClipboard();
    await copyMessageRow(scrollbackRow("12:34 <vjt> ciao mondo"));
    expect(writeText).toHaveBeenCalledWith("12:34 <vjt> ciao mondo");
    expect(copyToasts()).toHaveLength(0); // success is silent
  });

  // The issue is explicit: a failure is surfaced, never silent. `copyText`
  // throws with user-facing copy on a non-secure context (plain-http LAN
  // deploys are supported), and that text names the way out — select it by
  // hand, which is the very next item in this menu.
  it("surfaces a clipboard failure as a toast instead of swallowing it", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await copyMessageRow(scrollbackRow("12:34 <vjt> ciao"));
    expect(copyToasts()).toHaveLength(1);
    expect(copyToasts()[0]?.message).toMatch(/secure \(HTTPS\)/);
  });

  it("surfaces a rejected write too (denied permission)", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("NotAllowedError")) },
      configurable: true,
    });
    await copyMessageRow(scrollbackRow("12:34 <vjt> ciao"));
    expect(copyToasts()).toHaveLength(1);
  });
});

describe("selectMessageText", () => {
  function stubSelection(text: string): { addRange: Mock; ranges: Range[] } {
    const ranges: Range[] = [];
    const addRange = vi.fn((r: Range) => {
      ranges.push(r);
    });
    vi.spyOn(window, "getSelection").mockReturnValue({
      removeAllRanges: vi.fn(),
      addRange,
      toString: () => text,
      isCollapsed: text === "",
    } as unknown as Selection);
    return { addRange, ranges };
  }

  it("selects the whole row so the native handles have something to grab", () => {
    const { addRange, ranges } = stubSelection("12:34 <vjt> ciao");
    const row = scrollbackRow("12:34 <vjt> ciao");
    expect(selectMessageText(row)).toBe(true);
    expect(addRange).toHaveBeenCalledTimes(1);
    expect(ranges[0]?.commonAncestorContainer).toBe(row);
  });

  // THE point of the item. `html.is-ios` kills `-webkit-touch-callout`, and a
  // range installed under a suppressed callout has no draggable endpoints —
  // the second reported symptom. Select… lifts the kill, scoped in TIME.
  it("arms the callout re-enable while a selection is live", () => {
    stubSelection("12:34 <vjt> ciao");
    selectMessageText(scrollbackRow("12:34 <vjt> ciao"));
    expect(document.documentElement.classList.contains(SELECTING_CLASS)).toBe(true);
  });

  it("disarms it again as soon as the selection is cleared", () => {
    stubSelection("12:34 <vjt> ciao");
    selectMessageText(scrollbackRow("12:34 <vjt> ciao"));
    stubSelection(""); // the operator tapped away
    document.dispatchEvent(new Event("selectionchange"));
    expect(document.documentElement.classList.contains(SELECTING_CLASS)).toBe(false);
  });
});
