// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { bindMessageContextMenu } from "../lib/messageContextMenu";
import { disarmMessageSelection, SELECTING_CLASS } from "../lib/messageMenu";

// #1115 — the scrollback's DESKTOP door to the message menu. #1067 gave the
// menu one opener, a touch long-press, so a mouse user got the browser's own
// menu and none of ours. This binder is the second door, not a replacement:
// it owns `contextmenu` (right-click, Ctrl+click on macOS, and the keyboard
// Menu key — all one event) while `bindMessageGestures` keeps the touch
// stream untouched.
//
// jsdom proves the DECISION path: which right-clicks we claim, which we hand
// straight back to the browser, and where the menu is asked to appear. It
// does NOT prove that the native menu is really suppressed — that is the
// browser's response to `preventDefault`, which only a real browser can
// show, so the e2e spec carries that half.

let pane: HTMLDivElement;
let row: HTMLDivElement;
let body: HTMLSpanElement;
let nick: HTMLButtonElement;
let link: HTMLAnchorElement;
let onContextMenu: Mock<(row: HTMLElement, at: { x: number; y: number }) => void>;
let dispose: () => void;

beforeEach(() => {
  pane = document.createElement("div");
  pane.className = "scrollback";
  row = document.createElement("div");
  row.className = "scrollback-line";
  body = document.createElement("span");
  body.className = "scrollback-body";
  nick = document.createElement("button");
  nick.className = "scrollback-sender nick-clickable";
  link = document.createElement("a");
  link.className = "scrollback-link";
  row.append(nick, body, link);
  pane.appendChild(row);
  document.body.appendChild(pane);
  onContextMenu = vi.fn<(row: HTMLElement, at: { x: number; y: number }) => void>();
  dispose = bindMessageContextMenu(pane, { onContextMenu });
});

afterEach(() => {
  dispose();
  document.body.innerHTML = "";
  disarmMessageSelection(); // issue 1857 — the latch is <html>, outside <body>
  vi.restoreAllMocks(); // the live-selection test spies on window.getSelection
});

// A right-click at (x, y) on `target`. Returns the event so the caller can
// read `defaultPrevented` — the signal that decides whose menu the browser
// is about to show.
function rightClick(target: HTMLElement, x: number, y: number): MouseEvent {
  const e = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  target.dispatchEvent(e);
  return e;
}

// Pretend a selection is live. jsdom's Selection is real but has no layout to
// select over, so the flag the binder reads is stubbed directly.
function stubSelection(collapsed: boolean): void {
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: collapsed,
  } as unknown as Selection);
}

describe("bindMessageContextMenu — the desktop door", () => {
  it("opens the message menu at the cursor for a right-click on the row body", () => {
    rightClick(body, 412, 268);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu.mock.calls[0]?.[0]).toBe(row);
    expect(onContextMenu.mock.calls[0]?.[1]).toEqual({ x: 412, y: 268 });
  });

  it("claims the event so the browser's own menu never opens", () => {
    const e = rightClick(body, 412, 268);
    expect(e.defaultPrevented).toBe(true);
  });

  it("resolves the row from a right-click on the row's own padding", () => {
    rightClick(row, 30, 90);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu.mock.calls[0]?.[0]).toBe(row);
  });
});

describe("bindMessageContextMenu — what it refuses to claim", () => {
  // The nick span sits INSIDE the row, and it already owns right-click (it
  // opens UserContextMenu). Ours must not swallow it — and must not
  // preventDefault either, or the nick's own handler inherits a dead event.
  it("leaves a right-click on a nick to the nick menu", () => {
    const e = rightClick(nick, 100, 100);
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  // Same exclude list the touch owner and keepKeyboard use, so the three
  // policies cannot drift: a link's native menu (open in new tab, copy link
  // address) is worth more than ours.
  it("leaves a right-click on a link to the browser", () => {
    const e = rightClick(link, 100, 100);
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("ignores a right-click on the pane outside any message row", () => {
    const e = rightClick(pane, 100, 100);
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  // A live selection means the operator wants the browser's copy/search/
  // spellcheck menu — the same reason the touch owner stands down mid-
  // selection.
  it("yields to the browser while a selection is live", () => {
    stubSelection(false);
    const e = rightClick(body, 412, 268);
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("claims again once the selection is collapsed", () => {
    stubSelection(true);
    rightClick(body, 412, 268);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });
});

// issue 1857 — the same stale latch the touch door disarms. This door is not
// mouse-only in practice: `lib/platform.ts` puts `is-ios` on iPadOS in
// desktop-mode too (the `Mac` UA + `maxTouchPoints > 0` clause), and an iPad
// trackpad's secondary click arrives here as `contextmenu`. A door that opens
// the menu without ending the latch leaves the callout up over the whole
// scrollback for the next press.
describe("bindMessageContextMenu — a stale callout re-enable (issue 1857)", () => {
  it("lifts it when no selection is live any more", () => {
    document.documentElement.classList.add(SELECTING_CLASS);
    stubSelection(true);

    rightClick(body, 412, 268);

    expect(document.documentElement.classList.contains(SELECTING_CLASS)).toBe(false);
  });

  // Same carve-out as the touch door: a live selection is what the re-enable
  // is FOR, and this door is standing down to the browser's own menu over it.
  it("keeps it armed while a selection is live", () => {
    document.documentElement.classList.add(SELECTING_CLASS);
    stubSelection(false);

    rightClick(body, 412, 268);

    expect(document.documentElement.classList.contains(SELECTING_CLASS)).toBe(true);
  });

  it("lifts it on a right-click we hand straight back (a link)", () => {
    document.documentElement.classList.add(SELECTING_CLASS);
    stubSelection(true);

    const e = rightClick(link, 100, 100);

    expect(document.documentElement.classList.contains(SELECTING_CLASS)).toBe(false);
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("bindMessageContextMenu — lifecycle", () => {
  it("stops claiming after the disposer runs", () => {
    dispose();
    const e = rightClick(body, 412, 268);
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});
