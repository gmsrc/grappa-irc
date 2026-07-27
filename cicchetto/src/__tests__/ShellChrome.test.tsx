import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// UX-4 bucket L (2026-05-19) — ShellChrome unit tests.
//
// #71 INC-2 — ShellChrome is now MOBILE-ONLY and its old settings cog is
// gone: R1 moved the cog into the permanent right rail (RailActions,
// tested in RailActions.test.tsx), and this bar's right-edge button is
// now the ☰ RAIL OPENER (`shell-chrome-rail-opener`, prop `onOpenRail`)
// that opens that rail on non-channel mobile windows.
//
// #473 — the standalone archive button (📂) was REMOVED from ShellChrome.
// It was a third archive entry point; archive now lives as an always-on
// button in the RailActions drawer (reachable via this same ☰ opener), so
// the inline button + its `setArchiveModalNetwork` wiring are gone. The @
// mentions button remains (it derives its network via archiveContext).
//
// UX-5 bucket A (2026-05-19) — the hamburger slot was dropped from
// ShellChrome entirely. Pre-bucket the chrome rendered a hamburger
// that duplicated TopicBar's `.topic-bar-hamburger` on mobile and
// toggled a no-op `.open` class on desktop. Hamburger-related tests
// moved out; only the rail opener + @ mentions surfaces remain.
//
// UX-5 bucket BM (2026-05-20) — the `ChromeButtons` named export was
// dropped (BT introduced it for the mobile-channel `inlineChromeSlot`
// path; BM moved that surface into the members drawer footer, so the
// only consumer is gone and the export folded back into the default
// ShellChrome body). The `describe("ChromeButtons inline export")`
// block was deleted with the export.

// Selection is mocked per test. Returning null = empty (no window).
let mockSelected: {
  networkSlug: string;
  channelName: string;
  kind: "channel" | "query" | "server" | "home" | "mentions";
} | null = null;
const mockSetSelectedChannel = vi.fn();
vi.mock("../lib/selection", () => ({
  selectedChannel: () => mockSelected,
  setSelectedChannel: (...args: unknown[]) => mockSetSelectedChannel(...args),
  applySeedEnvelope: vi.fn(),
}));

// #188 — the open-mentions button only surfaces when a bundle exists for
// the selected window's network. A mutable holder lets each test control
// which slugs have a bundle.
const mentionsBundles = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../lib/mentionsWindow", () => ({
  mentionsBundleBySlug: () => mentionsBundles.value,
}));

// Post-bundle desktop fix — ShellChrome's archive button is now gated on
// `isMobile()` so desktop doesn't render it (Sidebar's `<details
// class="sidebar-archive">` already exposes parked rows inline). Mirror
// the Shell.test.tsx pattern: a mutable hoisted holder so individual
// describe blocks can flip mobile/desktop.
const mobileState = vi.hoisted(() => ({ value: true }));
vi.mock("../lib/theme", () => ({
  isMobile: () => mobileState.value,
  // #358 — customTheme's apply effect reads this; a constant is enough here.
  prefersDark: () => false,
}));

import ShellChrome from "../ShellChrome";

beforeEach(() => {
  vi.clearAllMocks();
  mockSelected = null;
  mobileState.value = true;
  mentionsBundles.value = {};
});

describe("ShellChrome (bucket L)", () => {
  // #71 INC-2 — the cog left this bar for the rail; the always-present
  // right-edge button is now the ☰ rail opener.
  it("always renders the rail opener (no window selected)", () => {
    render(() => <ShellChrome onOpenRail={vi.fn()} />);
    const opener = screen.getByTestId("shell-chrome-rail-opener");
    expect(opener).toBeInTheDocument();
  });

  it("clicking the rail opener fires onOpenRail", () => {
    const onOpenRail = vi.fn();
    render(() => <ShellChrome onOpenRail={onOpenRail} />);
    fireEvent.click(screen.getByTestId("shell-chrome-rail-opener"));
    expect(onOpenRail).toHaveBeenCalled();
  });

  // #71 INC-2 — the cog no longer lives in ShellChrome (moved to the rail's
  // ActionCluster). Guard against a regression that reintroduces it here.
  it("does NOT render the settings cog (moved to the rail's ActionCluster)", () => {
    render(() => <ShellChrome onOpenRail={vi.fn()} />);
    expect(screen.queryByTestId("shell-chrome-cog")).toBeNull();
    expect(screen.queryByTestId("action-cluster-cog")).toBeNull();
  });

  it("UX-5 bucket A — does NOT render a hamburger button (slot dropped)", () => {
    mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
    const { container } = render(() => <ShellChrome onOpenRail={vi.fn()} />);
    expect(container.querySelectorAll(".shell-chrome-hamburger").length).toBe(0);
    expect(screen.queryByLabelText(/open channel sidebar/i)).toBeNull();
    expect(screen.queryByLabelText(/open members sidebar/i)).toBeNull();
  });

  // #473 — the standalone archive button was removed from ShellChrome (it
  // was a third archive entry point). Guard against a regression that
  // reintroduces it: it must never render, on any window kind or viewport.
  it("does NOT render an archive button (#473 — archive lives in the RailActions drawer)", () => {
    mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
    render(() => <ShellChrome onOpenRail={vi.fn()} />);
    expect(screen.queryByTestId("shell-chrome-archive")).toBeNull();
  });

  // #188 item 6 — a button next to the rail opener opens the mentions
  // panel. It derives the network from the current selection and renders
  // ONLY when that network has a bundle to consult.
  describe("open-mentions button (#188)", () => {
    it("shows the button when the selected network has a mentions bundle", () => {
      mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
      mentionsBundles.value = { freenode: {} };
      render(() => <ShellChrome onOpenRail={vi.fn()} />);
      expect(screen.getByTestId("shell-chrome-mentions")).toBeInTheDocument();
    });

    it("hides the button when the selected network has no bundle", () => {
      mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
      mentionsBundles.value = {};
      render(() => <ShellChrome onOpenRail={vi.fn()} />);
      expect(screen.queryByTestId("shell-chrome-mentions")).toBeNull();
    });

    it("hides the button when no window carries a network context (home)", () => {
      mockSelected = { networkSlug: "home", channelName: "home", kind: "home" };
      mentionsBundles.value = { home: {} };
      render(() => <ShellChrome onOpenRail={vi.fn()} />);
      expect(screen.queryByTestId("shell-chrome-mentions")).toBeNull();
    });

    // #71 INC-2 — the @ open-mentions button is now MOBILE-ONLY. On desktop the
    // per-network Sidebar mentions row (Sidebar.tsx) replaces it, so ShellChrome
    // must NOT render the @ on desktop even when a bundle exists — else it would
    // duplicate the sidebar row. Mobile has no sidebar, so the @ stays here as
    // the only mentions re-open door (auto-nav on arrival covers the first open).
    it("#71 INC-2 — hides the @ on desktop even with a bundle (sidebar row replaces it)", () => {
      mobileState.value = false;
      mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
      mentionsBundles.value = { freenode: {} };
      render(() => <ShellChrome onOpenRail={vi.fn()} />);
      expect(screen.queryByTestId("shell-chrome-mentions")).toBeNull();
    });

    it("clicking it opens the mentions pseudo-window for the selected network", () => {
      mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
      mentionsBundles.value = { freenode: {} };
      render(() => <ShellChrome onOpenRail={vi.fn()} />);
      fireEvent.click(screen.getByTestId("shell-chrome-mentions"));
      expect(mockSetSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "",
        kind: "mentions",
      });
    });
  });
});
