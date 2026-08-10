import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

// GH #1178 — the IMPURE half of #235's jump verb: `stepActiveWindow`, reached
// through `jumpToNextActiveWindow` / `jumpToPrevActiveWindow`.
//
// `activeWindows.test.ts` covers the pure ordering (`orderUnreadWindows` and
// friends) with plain data. It cannot reach the bug this file exists for,
// because the bug is not in the ORDER — it is in what the verb DOES once the
// order resolves to the window the operator is already in.
//
// Reported state: scrolled back inside the only window with unread. The
// selected window stays in `activeWindows()` (selection.ts's read-at-the-tail
// suppression only fires when the pane is geometrically AT the tail), so the
// list is a single element that IS the current selection — and the resolved
// target is therefore the current selection, which `setSelectedChannel`
// short-circuits as a non-transition. Visible badge, nothing happens.
//
// The module's reactive singletons are driven by mocking the source modules
// the `activeWindows` memo reads. The memo caches (the mocks are plain
// functions, not signals), so each test resets the module registry and
// re-imports after seeding the holders.

const h = vi.hoisted(() => ({
  channels: [] as Array<{ name: string }>,
  unread: {} as Record<string, number>,
  selected: null as { networkSlug: string; channelName: string; kind: string } | null,
  setSelectedChannel: vi.fn(),
  isActiveSelection: vi.fn(),
  requestScrollToBottom: vi.fn(),
}));

vi.mock("../lib/networks", () => ({
  networks: () => [{ id: 1, slug: "net" }],
  channelsBySlug: () => ({ net: h.channels }),
}));

vi.mock("../lib/queryWindows", () => ({ queryWindowsByNetwork: () => ({}) }));

vi.mock("../lib/mentions", () => ({ mentionCounts: () => ({}) }));

vi.mock("../lib/notificationPrefs", () => ({
  notificationPrefs: () => ({ muted_targets: {} }),
}));

// No local rows: every window's activity id falls back to 0, so the ordering
// ties and resolves by flat (sidebar) order — deterministic without pinning
// scrollback shapes this file does not care about.
vi.mock("../lib/scrollback", () => ({ scrollbackByChannel: () => ({}) }));

vi.mock("../lib/selection", () => ({
  messagesUnread: () => h.unread,
  selectedChannel: () => h.selected,
  setSelectedChannel: h.setSelectedChannel,
  // Driven per test, mirroring Sidebar.test.tsx / BottomBar.test.tsx: the
  // equality RULE (`sameSelection`) is pinned in selection.test.ts; what these
  // tests pin is the WIRING, plus the exact tuple the verb resolved.
  isActiveSelection: h.isActiveSelection,
}));

vi.mock("../lib/scrollToBottomCommand", () => ({
  requestScrollToBottom: h.requestScrollToBottom,
}));

const chan = (name: string) => ({ networkSlug: "net", channelName: name, kind: "channel" });

const load = () => import("../lib/activeWindows");

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  h.channels = [];
  h.unread = {};
  h.selected = null;
  h.isActiveSelection.mockReturnValue(false);
});

describe("stepActiveWindow — the resolved target is the window you are already in (#1178)", () => {
  it("scrolls the pane to the newest message instead of re-selecting it", async () => {
    h.channels = [{ name: "#grappa" }];
    h.unread = { [channelKey("net", "#grappa")]: 4 };
    h.selected = chan("#grappa");
    h.isActiveSelection.mockReturnValue(true);

    const { jumpToNextActiveWindow } = await load();
    jumpToNextActiveWindow();

    // The arithmetic: a one-element list containing the current selection
    // resolves back to it.
    expect(h.isActiveSelection).toHaveBeenCalledWith(chan("#grappa"));
    expect(h.requestScrollToBottom).toHaveBeenCalledTimes(1);
    // Pre-#1178 this was the ONLY thing that happened, and it was a
    // non-transition the setter drops on the floor.
    expect(h.setSelectedChannel).not.toHaveBeenCalled();
  });

  it("does the same for the PREVIOUS direction (Ctrl+P)", async () => {
    h.channels = [{ name: "#grappa" }];
    h.unread = { [channelKey("net", "#grappa")]: 4 };
    h.selected = chan("#grappa");
    h.isActiveSelection.mockReturnValue(true);

    const { jumpToPrevActiveWindow } = await load();
    jumpToPrevActiveWindow();

    expect(h.requestScrollToBottom).toHaveBeenCalledTimes(1);
    expect(h.setSelectedChannel).not.toHaveBeenCalled();
  });
});

// Regression guards, not discriminators for the fix: each of these passes both
// before and after #1178. They exist so the cure cannot be "always scroll".
describe("stepActiveWindow — a real window switch is untouched", () => {
  it("steps to the OTHER unread window and does not scroll", async () => {
    h.channels = [{ name: "#grappa" }, { name: "#other" }];
    h.unread = {
      [channelKey("net", "#grappa")]: 1,
      [channelKey("net", "#other")]: 1,
    };
    h.selected = chan("#grappa");

    const { jumpToNextActiveWindow } = await load();
    jumpToNextActiveWindow();

    expect(h.setSelectedChannel).toHaveBeenCalledWith(chan("#other"));
    expect(h.requestScrollToBottom).not.toHaveBeenCalled();
  });

  it("selects the unread window when the current selection has no unread", async () => {
    h.channels = [{ name: "#grappa" }, { name: "#quiet" }];
    h.unread = { [channelKey("net", "#grappa")]: 1 };
    h.selected = chan("#quiet");

    const { jumpToNextActiveWindow } = await load();
    jumpToNextActiveWindow();

    expect(h.setSelectedChannel).toHaveBeenCalledWith(chan("#grappa"));
    expect(h.requestScrollToBottom).not.toHaveBeenCalled();
  });

  it("fires neither verb when nothing is unread", async () => {
    h.channels = [{ name: "#grappa" }];
    h.selected = chan("#grappa");

    const { jumpToNextActiveWindow } = await load();
    jumpToNextActiveWindow();

    expect(h.setSelectedChannel).not.toHaveBeenCalled();
    expect(h.requestScrollToBottom).not.toHaveBeenCalled();
  });
});
