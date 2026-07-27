import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #473 — RailActions is the ONE labelled button drawer at the bottom of the
// members rail. It carries every rail affordance — home · rooms · themes ·
// archive · settings · admin · denoise — each as an icon + TEXT label,
// identical on desktop and mobile. It supersedes the two split surfaces
// (#71 INC-2 ActionCluster at the top + the mobile `.mobile-panel-actions`
// footer) AND the desktop Sidebar `<details>` archive. Per-button gating that
// is about CAPABILITY, not form factor, stays: admin is isAdmin()-gated, rooms
// needs a network context, denoise is channel-gated. Archive is ALWAYS shown
// (like settings) — the grouped multi-network ArchiveModal must be reachable
// from every window kind. The mobile-only form-factor gates are dropped —
// desktop gets the same set.
//
// Store reads (selection, networks isAdmin, archiveContext) are mocked so the
// gates are driven deterministically; the mobilePanel helpers are spied to
// assert the buttons route through the shared mutex layer (CLAUDE.md: assert
// outcomes, and reuse the ONE launcher-mutex path). channelKey is stubbed and
// the REAL presenceFilter + members stores drive the denoise toggle wiring
// (use production code, don't re-implement logic).

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

const adminHolder = { value: false };
vi.mock("../lib/networks", () => ({
  isAdmin: () => adminHolder.value,
}));

type Sel = { networkSlug: string; channelName: string; kind: string } | null;
const selHolder: { value: Sel } = { value: null };
const setSelectedChannel = vi.fn();
vi.mock("../lib/selection", () => ({
  selectedChannel: () => selHolder.value,
  setSelectedChannel: (...args: unknown[]) => setSelectedChannel(...args),
}));

const roomsSlugHolder: { value: string | null } = { value: "freenode" };
vi.mock("../lib/archiveContext", () => ({
  archiveSlugForSelection: () => roomsSlugHolder.value,
}));

const openHomePanel = vi.fn();
const openListPanel = vi.fn();
const openThemesPanel = vi.fn();
const openAdminPanel = vi.fn();
const openSettingsPanel = vi.fn();
const openArchivePanel = vi.fn();
vi.mock("../lib/mobilePanel", () => ({
  openHomePanel: (...a: unknown[]) => openHomePanel(...a),
  openListPanel: (...a: unknown[]) => openListPanel(...a),
  openThemesPanel: (...a: unknown[]) => openThemesPanel(...a),
  openAdminPanel: (...a: unknown[]) => openAdminPanel(...a),
  openSettingsPanel: (...a: unknown[]) => openSettingsPanel(...a),
  openArchivePanel: (...a: unknown[]) => openArchivePanel(...a),
}));

import RailActions from "../RailActions";

const channelSel: Sel = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };

const setters = {
  membersOpen: () => false,
  setMembersOpen: vi.fn(),
  setSettingsOpen: vi.fn(),
};

beforeEach(() => {
  adminHolder.value = false;
  selHolder.value = null;
  roomsSlugHolder.value = "freenode";
});

afterEach(() => {
  vi.clearAllMocks();
  // togglePresence persists an explicit pref in localStorage — clear it so it
  // can't leak into sibling tests reading the same key.
  localStorage.clear();
});

describe("RailActions (#473)", () => {
  it("always renders the settings cog with the kept testid + aria-label", () => {
    render(() => <RailActions setters={setters} />);
    const cog = screen.getByTestId("action-cluster-cog");
    expect(cog).toBeInTheDocument();
    // Many e2e specs locate the cog via getByLabel(/open settings/i) — the
    // aria-label is a load-bearing contract, kept verbatim.
    expect(cog).toHaveAttribute("aria-label", "open settings");
  });

  it("clicking the cog routes through openSettingsPanel(setters)", () => {
    render(() => <RailActions setters={setters} />);
    fireEvent.click(screen.getByTestId("action-cluster-cog"));
    expect(openSettingsPanel).toHaveBeenCalledWith(setters);
  });

  it("renders home / themes always, each with an icon and a TEXT label", () => {
    render(() => <RailActions setters={setters} />);
    const home = screen.getByTestId("mobile-panel-home");
    const themes = screen.getByTestId("mobile-panel-themes");
    expect(home).toBeInTheDocument();
    expect(themes).toBeInTheDocument();
    // #473 — the button now carries its name as visible text next to the glyph.
    expect(home).toHaveTextContent("home");
    expect(themes).toHaveTextContent("themes");
  });

  it("the /list launcher is labelled 'rooms' but keeps the mobile-panel-list testid", () => {
    render(() => <RailActions setters={setters} />);
    const rooms = screen.getByTestId("mobile-panel-list");
    expect(rooms).toBeInTheDocument();
    expect(rooms).toHaveTextContent("rooms");
    // Trap #1: the button survives, so its testid stays pointed at a real thing.
    expect(rooms).not.toHaveTextContent("list");
  });

  it("home routes through openHomePanel; rooms through openListPanel", () => {
    render(() => <RailActions setters={setters} />);
    fireEvent.click(screen.getByTestId("mobile-panel-home"));
    expect(openHomePanel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("mobile-panel-list"));
    expect(openListPanel).toHaveBeenCalledTimes(1);
  });

  it("always renders the archive button with an icon and a TEXT label", () => {
    render(() => <RailActions setters={setters} />);
    const archive = screen.getByTestId("mobile-panel-archive");
    expect(archive).toBeInTheDocument();
    expect(archive).toHaveTextContent("archive");
    expect(archive).toHaveAttribute("aria-label", "open archive");
  });

  it("archive is NOT selection-gated: shown even with no network context", () => {
    // rooms hides on a null slug, but archive stays — the grouped
    // ArchiveModal is the single archive surface and must be reachable from
    // home / mentions / admin (which have no network) too.
    roomsSlugHolder.value = null;
    selHolder.value = null;
    render(() => <RailActions setters={setters} />);
    expect(screen.queryByTestId("mobile-panel-list")).toBeNull();
    expect(screen.getByTestId("mobile-panel-archive")).toBeInTheDocument();
  });

  it("clicking archive routes through openArchivePanel(setters)", () => {
    render(() => <RailActions setters={setters} />);
    fireEvent.click(screen.getByTestId("mobile-panel-archive"));
    expect(openArchivePanel).toHaveBeenCalledWith(setters);
  });

  it("gates rooms on a network context (archiveSlugForSelection null ⇒ hidden)", () => {
    roomsSlugHolder.value = null;
    render(() => <RailActions setters={setters} />);
    expect(screen.queryByTestId("mobile-panel-list")).toBeNull();
  });

  it("gates admin on isAdmin(): hidden when false, shown when true", () => {
    const { unmount } = render(() => <RailActions setters={setters} />);
    expect(screen.queryByTestId("mobile-panel-admin")).toBeNull();
    unmount();
    adminHolder.value = true;
    render(() => <RailActions setters={setters} />);
    const admin = screen.getByTestId("mobile-panel-admin");
    expect(admin).toBeInTheDocument();
    expect(admin).toHaveTextContent("admin");
  });

  it("does NOT render the denoise toggle on a non-channel window (selection null)", () => {
    selHolder.value = null;
    render(() => <RailActions setters={setters} />);
    expect(screen.queryByTestId("presence-toggle")).toBeNull();
  });

  it("renders the channel-gated denoise toggle (with label) on a channel window", () => {
    selHolder.value = channelSel;
    render(() => <RailActions setters={setters} />);
    const toggle = screen.getByTestId("presence-toggle");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveTextContent("denoise");
    expect(toggle).toHaveClass("shell-chrome-btn");
  });

  it("toggling denoise flips the .presence-hidden accent state (explicit pref wins)", () => {
    selHolder.value = channelSel;
    const { container } = render(() => <RailActions setters={setters} />);
    const toggle = container.querySelector("[data-testid='presence-toggle']") as HTMLElement;
    expect(toggle).not.toHaveClass("presence-hidden");
    fireEvent.click(toggle);
    expect(toggle).toHaveClass("presence-hidden");
    expect(toggle).toHaveClass("shell-chrome-btn");
  });
});
