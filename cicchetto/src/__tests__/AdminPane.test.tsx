import { fireEvent, render, screen } from "@solidjs/testing-library";
import type { Channel } from "phoenix";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// M-cluster M-8 / M-9b / M-10 / M-11 + UX-6-B2 — AdminPane mounts the
// Sessions + Networks + Events + Settings tabs inside their respective
// tabpanels. Mock them so this suite stays focused on the OUTER PANE
// contract (header + tab nav + active-tab switching + admin-events
// subscription lifecycle).
//
// #1157 — Visitors is no longer among them: it merged into Sessions,
// which now lists both subject kinds, active and inactive.

vi.mock("../AdminSessionsTab", () => ({
  default: () => <div data-testid="admin-sessions-tab-mock">sessions-tab</div>,
}));

vi.mock("../AdminNetworksTab", () => ({
  default: () => <div data-testid="admin-networks-tab-mock">networks-tab</div>,
}));

vi.mock("../AdminEventsTab", () => ({
  default: () => <div data-testid="admin-events-tab-mock">events-tab</div>,
}));

vi.mock("../AdminSessionLogTab", () => ({
  default: () => <div data-testid="admin-session-log-tab-mock">session-log-tab</div>,
}));

vi.mock("../AdminSettingsTab", () => ({
  default: () => <div data-testid="admin-settings-tab-mock">settings-tab</div>,
}));

// Mock the adminEvents subscription lifecycle. AdminPane calls these
// at mount/unmount; the actual channel join is exercised by the
// Playwright e2e + AdminEventsTab unit suite, not here.
const startSub = vi.fn();
const uninstall = vi.fn();
vi.mock("../lib/adminEvents", () => ({
  startAdminEventsSubscription: () => startSub(),
  uninstallAdminEvents: () => uninstall(),
  adminEvents: () => [],
}));

import AdminPane from "../AdminPane";
// NOT mocked: the overview store is a plain signal with no socket of its own
// (adminEvents.ts owns the channel), so the pane's wiring to it is exercised
// for real by installing a fake channel and firing the server's push.
import { installAdminOverview, resetAdminOverview } from "../lib/adminOverview";

// M-cluster M-7 / M-8 / M-9b / M-10 / M-11 — admin console pane.
// Per `feedback_e2e_user_class_parity_matrix`: AdminPane itself is
// subject-agnostic; the admin-only gate lives at SettingsDrawer +
// Shell.tsx (which only mount this when `me.is_admin === true`).

describe("AdminPane", () => {
  it("renders the 'admin console' header", () => {
    render(() => <AdminPane onOpenRail={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /admin console/i })).toBeInTheDocument();
  });

  it("renders the tabs with Sessions as the default-active tab", () => {
    render(() => <AdminPane onOpenRail={vi.fn()} />);
    const sessionsTab = screen.getByTestId("admin-tab-sessions");
    const networksTab = screen.getByTestId("admin-tab-networks");
    const eventsTab = screen.getByTestId("admin-tab-events");
    const settingsTab = screen.getByTestId("admin-tab-settings");
    // textContent assertion per `feedback_css_block_button_wraps_inline_prefix`.
    expect(sessionsTab.textContent).toContain("Sessions");
    expect(networksTab.textContent).toContain("Networks");
    expect(eventsTab.textContent).toContain("Events");
    expect(settingsTab.textContent).toContain("Settings");
    expect(sessionsTab.getAttribute("aria-selected")).toBe("true");
    expect(networksTab.getAttribute("aria-selected")).toBe("false");
    expect(eventsTab.getAttribute("aria-selected")).toBe("false");
    expect(settingsTab.getAttribute("aria-selected")).toBe("false");
    expect(eventsTab.getAttribute("role")).toBe("tab");
    expect(settingsTab.getAttribute("role")).toBe("tab");
  });

  it("mounts AdminSessionsTab inside the active tabpanel by default", () => {
    render(() => <AdminPane onOpenRail={vi.fn()} />);
    expect(screen.getByTestId("admin-sessions-tab-mock")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-networks-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-events-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-settings-tab-mock")).toBeNull();
  });

  // #1157 — the tab is gone, so the handle must be gone too: a dead
  // handle would still switch `currentTab` and render an empty panel.
  it("has no Visitors tab handle at all", () => {
    render(() => <AdminPane onOpenRail={vi.fn()} />);
    expect(screen.queryByTestId("admin-tab-visitors")).toBeNull();
  });

  it("clicking the Networks tab swaps the active panel + flips aria-selected", () => {
    render(() => <AdminPane onOpenRail={vi.fn()} />);
    fireEvent.click(screen.getByTestId("admin-tab-networks"));
    expect(screen.getByTestId("admin-networks-tab-mock")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-events-tab-mock")).toBeNull();
    expect(screen.getByTestId("admin-tab-networks").getAttribute("aria-selected")).toBe("true");
  });

  it("clicking the Events tab swaps the active panel + flips aria-selected", () => {
    render(() => <AdminPane onOpenRail={vi.fn()} />);
    fireEvent.click(screen.getByTestId("admin-tab-events"));
    expect(screen.getByTestId("admin-events-tab-mock")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-sessions-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-networks-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-settings-tab-mock")).toBeNull();
    expect(screen.getByTestId("admin-tab-events").getAttribute("aria-selected")).toBe("true");
  });

  it("clicking the Session Log tab swaps the active panel + flips aria-selected (#215)", () => {
    render(() => <AdminPane onOpenRail={vi.fn()} />);
    fireEvent.click(screen.getByTestId("admin-tab-session_log"));
    expect(screen.getByTestId("admin-session-log-tab-mock")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-events-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-settings-tab-mock")).toBeNull();
    expect(screen.getByTestId("admin-tab-session_log").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("admin-tab-events").getAttribute("aria-selected")).toBe("false");
  });

  it("clicking the Settings tab swaps the active panel + flips aria-selected (UX-6-B2)", () => {
    render(() => <AdminPane onOpenRail={vi.fn()} />);
    fireEvent.click(screen.getByTestId("admin-tab-settings"));
    expect(screen.getByTestId("admin-settings-tab-mock")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-sessions-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-networks-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-events-tab-mock")).toBeNull();
    expect(screen.getByTestId("admin-tab-settings").getAttribute("aria-selected")).toBe("true");
  });

  it("clicking back to Sessions after Networks returns the original panel", () => {
    render(() => <AdminPane onOpenRail={vi.fn()} />);
    fireEvent.click(screen.getByTestId("admin-tab-networks"));
    fireEvent.click(screen.getByTestId("admin-tab-sessions"));
    expect(screen.getByTestId("admin-sessions-tab-mock")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-networks-tab-mock")).toBeNull();
  });

  // #1073 — vjt: *"la x sparisce"*. Not relocated: DELETED. Selection is what
  // mounts and unmounts this pane, and the rail the ☰ opens already carries
  // `home` and `rooms`, so a "close admin" verb would be a second name for the
  // work `home` already does. The pane consequently has no `onClose` prop at
  // all — there is no caller left to hand one to.
  it("carries no close ×: leaving the console is the rail's job", () => {
    render(() => <AdminPane onOpenRail={vi.fn()} />);
    expect(screen.queryByTestId("admin-pane-close")).toBeNull();
    expect(screen.queryByLabelText(/close admin console/i)).toBeNull();
  });

  // #1073 — the band is the channel windows' bar, not a lookalike. vjt: *"la
  // top bar admin dev'esser possibilmente la stessa barra che abbiamo per i
  // canali, solo con dentro roba diversa"*. `.admin-pane-header` was a second
  // implementation of the same idea on the `--adm-*` layer, and the two
  // disagreed about which side the ☰ sits on.
  describe("#1073 — the band is the shared pane top bar", () => {
    it("renders `.topic-bar`, and the private `.admin-pane-header` is gone", () => {
      const { container } = render(() => <AdminPane onOpenRail={vi.fn()} />);
      expect(container.querySelector(".topic-bar")).not.toBeNull();
      expect(container.querySelector(".admin-pane-header")).toBeNull();
    });

    // The side is not a CSS override, it is the child order — the same fact
    // `TopicBar.test.tsx` pins for the channel host.
    it("puts the ☰ LAST, which is what places it on the right", () => {
      const { container } = render(() => <AdminPane onOpenRail={vi.fn()} />);
      const bar = container.querySelector(".topic-bar");
      expect(bar?.lastElementChild).toHaveClass("topic-bar-hamburger");
    });

    it("the ☰ opens the rail", () => {
      const onOpenRail = vi.fn();
      const { container } = render(() => <AdminPane onOpenRail={onOpenRail} />);
      const ham = container.querySelector(".topic-bar-hamburger");
      expect(ham).not.toBeNull();
      fireEvent.click(ham as Element);
      expect(onOpenRail).toHaveBeenCalledTimes(1);
    });

    // The accessible name is UNCHANGED from the inline `RailOpenerButton` this
    // replaces: the admin door has always been "open actions" and the channel
    // one "open members sidebar". `ux-4-z-cluster-journey` reaches this door on
    // the admin window, and eight specs reach the channel one by its own name.
    it("keeps the admin door's accessible name", () => {
      render(() => <AdminPane onOpenRail={vi.fn()} />);
      expect(screen.getByLabelText(/open actions/i)).toBeInTheDocument();
    });
  });

  // #1073 — the issue's "Done when": the bar's LEFT side carries the live key
  // stats. They are mounted in `PaneTopBar`'s content slot, the same slot the
  // channel bar fills with its namebox and topic strip.
  describe("#1073 — the live stats in the bar's left group", () => {
    const OVERVIEW = {
      sessions: 3,
      visitors: { total: 5, live: 2 },
      hostname: "m42",
      loadavg: 0.42,
      version: "0.15.0",
    };

    function fakeChannel(): { channel: Channel; fire: (p: unknown) => void } {
      let cb: ((p: unknown) => void) | null = null;
      const channel = {
        on: (name: string, handler: unknown) => {
          if (name === "overview") cb = handler as (p: unknown) => void;
          return 0;
        },
        leave: () => ({ receive: () => ({ receive: () => undefined }) }),
      } as unknown as Channel;
      return { channel, fire: (p) => cb?.(p) };
    }

    beforeEach(() => resetAdminOverview());
    afterEach(() => resetAdminOverview());

    it("renders the stats once the first push has landed", () => {
      const fake = fakeChannel();
      installAdminOverview(fake.channel);
      fake.fire(OVERVIEW);

      const { container } = render(() => <AdminPane onOpenRail={vi.fn()} />);

      const stats = container.querySelector(".admin-overview-stats");
      expect(stats).not.toBeNull();
      expect(stats?.textContent ?? "").toContain("m42");
    });

    it("puts them INSIDE the bar's content slot, not loose in the pane", () => {
      // `.topic-bar-header` is the slot; anything outside it is a second row of
      // chrome, which is the thing #1073 removes rather than adds.
      const fake = fakeChannel();
      installAdminOverview(fake.channel);
      fake.fire(OVERVIEW);

      const { container } = render(() => <AdminPane onOpenRail={vi.fn()} />);

      expect(container.querySelector(".topic-bar-header .admin-overview-stats")).not.toBeNull();
    });

    it("still puts the ☰ last, with the stats in front of it", () => {
      const fake = fakeChannel();
      installAdminOverview(fake.channel);
      fake.fire(OVERVIEW);

      const { container } = render(() => <AdminPane onOpenRail={vi.fn()} />);

      expect(container.querySelector(".topic-bar")?.lastElementChild).toHaveClass(
        "topic-bar-hamburger",
      );
    });

    it("renders the bar with no stats at all before the first push", () => {
      const { container } = render(() => <AdminPane onOpenRail={vi.fn()} />);
      expect(container.querySelector(".topic-bar")).not.toBeNull();
      expect(container.querySelector(".admin-overview-stats")).toBeNull();
    });

    it("updates in place when the next tick arrives", () => {
      const fake = fakeChannel();
      installAdminOverview(fake.channel);
      fake.fire(OVERVIEW);

      const { container } = render(() => <AdminPane onOpenRail={vi.fn()} />);
      fake.fire({ ...OVERVIEW, sessions: 9, hostname: "m43" });

      expect(container.querySelectorAll(".admin-overview-stats").length).toBe(1);
      expect(container.querySelector(".admin-overview-stats")?.textContent ?? "").toContain("m43");
    });
  });

  it("starts admin-events subscription on mount, tears down on unmount (M-11)", () => {
    startSub.mockClear();
    uninstall.mockClear();
    const { unmount } = render(() => <AdminPane onOpenRail={vi.fn()} />);
    expect(startSub).toHaveBeenCalledTimes(1);
    expect(uninstall).toHaveBeenCalledTimes(0);
    unmount();
    expect(uninstall).toHaveBeenCalledTimes(1);
  });
});
