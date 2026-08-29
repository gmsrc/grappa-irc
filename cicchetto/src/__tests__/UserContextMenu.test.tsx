import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// C5.1 — UserContextMenu: right-click submenu on member nick.
//
// Tests assert:
//   1. All 9 items render (op/deop/voice/devoice/kick/ban/WHOIS/CTCP/query).
//   2. When own nick has @-mode, op-gated items are enabled.
//   3. When own nick lacks @-mode, op-gated items are disabled (not hidden).
//   4. WHOIS + Query are always enabled regardless of modes.
//   5. Clicking an enabled item fires the correct socket push.
//   6. Clicking outside fires onClose.
//   7. Pressing Escape fires onClose.

const mockPushChannelOp = vi.fn();
const mockPushChannelDeop = vi.fn();
const mockPushChannelVoice = vi.fn();
const mockPushChannelDevoice = vi.fn();
const mockPushChannelKick = vi.fn();
const mockPushChannelBan = vi.fn();
const mockPushWhois = vi.fn();
const mockOpenQueryWindowState = vi.fn();
const mockSetSelectedChannel = vi.fn();
const mockSendCtcpQuery = vi.fn();

vi.mock("../lib/socket", () => ({
  pushChannelOp: (...args: unknown[]) => mockPushChannelOp(...args),
  pushChannelDeop: (...args: unknown[]) => mockPushChannelDeop(...args),
  pushChannelVoice: (...args: unknown[]) => mockPushChannelVoice(...args),
  pushChannelDevoice: (...args: unknown[]) => mockPushChannelDevoice(...args),
  pushChannelKick: (...args: unknown[]) => mockPushChannelKick(...args),
  pushChannelBan: (...args: unknown[]) => mockPushChannelBan(...args),
  pushWhois: (...args: unknown[]) => mockPushWhois(...args),
}));

// #1192 — the CTCP submenu dispatches through the shared seam; its own
// contract (the #640 source-window echo, the #600 ordering) is pinned in
// ctcpQuery.test.ts, so here it is a boundary spy. Resolves, because the
// production action attaches a `.catch` and an unhandled rejection from a
// bare `vi.fn()` would fail the run for the wrong reason.
vi.mock("../lib/ctcpQuery", () => ({
  sendCtcpQuery: (...args: unknown[]) => mockSendCtcpQuery(...args),
}));

vi.mock("../lib/networks", () => ({
  // #1861 — casemappingForSlug (lib/casemapping.ts) resolves the fold
  // through this map, so the mock has to carry it.
  networkIdBySlug: () => undefined,
  networks: vi.fn(() => [{ id: 42, slug: "freenode", inserted_at: "x", updated_at: "y" }]),
}));

vi.mock("../lib/queryWindows", () => ({
  openQueryWindowState: (...args: unknown[]) => mockOpenQueryWindowState(...args),
  queryWindowsByNetwork: vi.fn(() => ({})),
  canonicalQueryNick: (_networkId: number, nick: string) => nick,
}));

vi.mock("../lib/selection", () => ({
  setSelectedChannel: (...args: unknown[]) => mockSetSelectedChannel(...args),
  selectedChannel: vi.fn(() => null),
  applySeedEnvelope: vi.fn(),
}));

// We also need to mock pushWhois — UserContextMenu uses pushWhois from socket.ts.
// The mock above covers it.

import {
  __resetForTest,
  overlayEscapeDepth,
  runTopmostOverlayEscape,
} from "../lib/overlayScrollLock";
import UserContextMenu from "../UserContextMenu";

const baseProps = {
  networkSlug: "freenode",
  networkId: 42,
  channelName: "#grappa",
  targetNick: "alice",
  ownModes: [] as string[],
  position: { x: 100, y: 200 },
  onClose: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSendCtcpQuery.mockResolvedValue(undefined);
  __resetForTest();
});

describe("UserContextMenu", () => {
  describe("renders all 9 items", () => {
    it("shows Op, Deop, Voice, Devoice, Kick, Ban, WHOIS, CTCP, Query", () => {
      render(() => <UserContextMenu {...baseProps} />);
      expect(screen.getByRole("button", { name: /^op$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^deop$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^voice$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^devoice$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^kick$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^ban$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^whois$/i })).toBeInTheDocument();
      // #1192 — the shell appends the ▸, so the accessible name carries it.
      expect(screen.getByRole("button", { name: /^ctcp ▸$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^query$/i })).toBeInTheDocument();
    });
  });

  describe("permission gating (own nick has no @ mode)", () => {
    it("disables op-gated items when ownModes is empty", () => {
      render(() => <UserContextMenu {...baseProps} ownModes={[]} />);
      expect(screen.getByRole("button", { name: /^op$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^deop$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^voice$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^devoice$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^kick$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^ban$/i })).toBeDisabled();
    });

    it("disabled items are NOT hidden (still rendered)", () => {
      render(() => <UserContextMenu {...baseProps} ownModes={[]} />);
      // All 6 op-gated items are in DOM but disabled.
      const opBtn = screen.getByRole("button", { name: /^op$/i });
      expect(opBtn).toBeInTheDocument();
      expect(opBtn).toBeDisabled();
    });

    it("WHOIS and Query are always enabled regardless of ownModes", () => {
      render(() => <UserContextMenu {...baseProps} ownModes={[]} />);
      expect(screen.getByRole("button", { name: /^whois$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^query$/i })).not.toBeDisabled();
    });
  });

  describe("permission gating (own nick has @ mode)", () => {
    it("enables op-gated items when ownModes includes @", () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      expect(screen.getByRole("button", { name: /^op$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^deop$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^voice$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^devoice$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^kick$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^ban$/i })).not.toBeDisabled();
    });
  });

  describe("actions dispatch to correct socket helpers (ownModes = [@])", () => {
    it("Op button calls pushChannelOp with networkId, channel, [nick]", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^op$/i }));
      expect(mockPushChannelOp).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Deop button calls pushChannelDeop", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^deop$/i }));
      expect(mockPushChannelDeop).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Voice button calls pushChannelVoice", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^voice$/i }));
      expect(mockPushChannelVoice).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Devoice button calls pushChannelDevoice", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^devoice$/i }));
      expect(mockPushChannelDevoice).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Kick button calls pushChannelKick with empty reason", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^kick$/i }));
      expect(mockPushChannelKick).toHaveBeenCalledWith(42, "#grappa", "alice", "");
    });

    it("Ban button calls pushChannelBan with nick!*@* fallback mask", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^ban$/i }));
      expect(mockPushChannelBan).toHaveBeenCalledWith(42, "#grappa", "alice!*@*");
    });

    it("Query button calls openQueryWindowState and setSelectedChannel", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^query$/i }));
      expect(mockOpenQueryWindowState).toHaveBeenCalledWith(42, "alice", expect.any(String));
      expect(mockSetSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "alice",
        kind: "query",
      });
    });

    it("CTCP drills into the six verbs instead of acting", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^ctcp ▸$/i }));

      // The whole point of the group: six verbs behind ONE row, so the nick
      // menu does not grow to fourteen.
      for (const verb of ["VERSION", "TIME", "PING", "CLIENTINFO", "USERINFO", "SOURCE"]) {
        expect(
          screen.getByRole("button", { name: new RegExp(`^${verb}$`, "i") }),
        ).not.toBeDisabled();
      }
      expect(mockSendCtcpQuery).not.toHaveBeenCalled();
    });

    it("a CTCP verb dispatches against the SOURCE window, with no invented args", async () => {
      vi.spyOn(Date, "now").mockReturnValue(1706743200000);
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^ctcp ▸$/i }));
      fireEvent.click(screen.getByRole("button", { name: /^version$/i }));

      // `sourceChannel` is the window the operator is looking at (#640) and the
      // recipient travels separately — the probe must not mint a query tab.
      // `args: ""` because a menu row has nowhere to type one, and because a
      // BARE ping is what the #637 token-less fallback correlates.
      expect(mockSendCtcpQuery).toHaveBeenCalledWith({
        networkSlug: "freenode",
        networkId: 42,
        sourceChannel: "#grappa",
        targetNick: "alice",
        verb: "VERSION",
        args: "",
        sentAtMs: 1706743200000,
      });
      vi.mocked(Date.now).mockRestore();
    });

    it("PING goes through the same door as every other verb", async () => {
      // No special case at the call site is the point: the seam decides what
      // correlates, off the VERB. A menu that hand-rolled PING here is exactly
      // the drift #1192 moved the ordering into the seam to prevent.
      vi.spyOn(Date, "now").mockReturnValue(1706743200000);
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^ctcp ▸$/i }));
      fireEvent.click(screen.getByRole("button", { name: /^ping$/i }));

      expect(mockSendCtcpQuery).toHaveBeenCalledWith({
        networkSlug: "freenode",
        networkId: 42,
        sourceChannel: "#grappa",
        targetNick: "alice",
        verb: "PING",
        args: "",
        sentAtMs: 1706743200000,
      });
      vi.mocked(Date.now).mockRestore();
    });

    it("WHOIS button calls pushWhois with networkId and nick (server null)", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^whois$/i }));
      // #198 — context-menu WHOIS is single-nick: null target-server.
      expect(mockPushWhois).toHaveBeenCalledWith(42, "alice", null);
    });
  });

  describe("close behaviour", () => {
    it("calls onClose when backdrop is clicked", async () => {
      const onClose = vi.fn();
      render(() => <UserContextMenu {...baseProps} onClose={onClose} />);
      const backdrop = document.querySelector(".context-menu-backdrop");
      expect(backdrop).toBeInTheDocument();
      if (backdrop) fireEvent.click(backdrop);
      expect(onClose).toHaveBeenCalled();
    });

    // #1411 — this used to fire a keydown at `document` and catch the menu's
    // own private listener. That listener is gone: Escape now arrives through
    // the ONE shared ESC stack, so the host-level assertion is that the menu
    // ENROLLED. The full door (real keypress → keybindings → stack, and the
    // drawer that no longer closes with it) is driven in cardEscape.test.tsx.
    it("enrols in the shared ESC stack, and dismisses when it is run", async () => {
      const onClose = vi.fn();
      render(() => <UserContextMenu {...baseProps} onClose={onClose} />);

      expect(overlayEscapeDepth()).toBe(1);
      expect(runTopmostOverlayEscape()).toBe(true);

      expect(onClose).toHaveBeenCalled();
    });
  });
});
