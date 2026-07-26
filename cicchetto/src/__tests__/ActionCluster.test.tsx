import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

// #71 INC-2 — ActionCluster is the right-rail button group R1 makes a
// PERMANENT surface. It ships carrying exactly two affordances: the settings
// cog (ALWAYS rendered — the cluster-wide "settings reachable from every
// window" rule) and the channel-gated presence toggle (👁/🙈, moved out of
// TopicBar). channelKey is mocked for a deterministic key; the presence store
// (presenceFilter) + members store are the REAL implementations so the toggle
// wiring is exercised with production code (CLAUDE.md: use production code in
// tests, never re-implement logic).

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

import ActionCluster from "../ActionCluster";

const channelCtx = { networkSlug: "freenode", channelName: "#italia" };

afterEach(() => {
  // togglePresence persists an explicit pref in localStorage — clear it so it
  // can't leak into sibling tests reading the same key.
  localStorage.clear();
});

describe("ActionCluster (#71 INC-2)", () => {
  it("always renders the settings cog, even with no channel context", () => {
    render(() => <ActionCluster onOpenSettings={vi.fn()} channel={null} />);
    expect(screen.getByTestId("action-cluster-cog")).toBeInTheDocument();
  });

  it("clicking the cog fires onOpenSettings", () => {
    const onOpenSettings = vi.fn();
    render(() => <ActionCluster onOpenSettings={onOpenSettings} channel={null} />);
    fireEvent.click(screen.getByTestId("action-cluster-cog"));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("does NOT render the presence toggle on a non-channel window (channel null)", () => {
    render(() => <ActionCluster onOpenSettings={vi.fn()} channel={null} />);
    expect(screen.queryByTestId("presence-toggle")).toBeNull();
  });

  it("renders the channel-gated presence toggle when a channel is shown", () => {
    render(() => <ActionCluster onOpenSettings={vi.fn()} channel={channelCtx} />);
    expect(screen.getByTestId("presence-toggle")).toBeInTheDocument();
  });

  it("the presence toggle wears the shared .shell-chrome-btn base (size tokens)", () => {
    const { container } = render(() => (
      <ActionCluster onOpenSettings={vi.fn()} channel={channelCtx} />
    ));
    const toggle = container.querySelector(".action-cluster-presence-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle).toHaveClass("shell-chrome-btn");
  });

  it("toggling presence flips the .presence-hidden accent state (explicit pref wins)", () => {
    const { container } = render(() => (
      <ActionCluster onOpenSettings={vi.fn()} channel={channelCtx} />
    ));
    const toggle = container.querySelector(".action-cluster-presence-toggle") as HTMLElement;
    // Default (small channel, no explicit pref) → shown → no accent.
    expect(toggle).not.toHaveClass("presence-hidden");
    fireEvent.click(toggle);
    // One tap writes an explicit "hide" pref → accent state, base class kept.
    expect(toggle).toHaveClass("presence-hidden");
    expect(toggle).toHaveClass("shell-chrome-btn");
  });
});
