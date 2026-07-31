import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { Network } from "../lib/api";
import type { SelectedChannel } from "../lib/selection";
import type { WindowKind } from "../lib/windowKinds";

// #474 — RailContext is the GENERIC per-window-kind context surface grafted
// as a sibling of the RailActions drawer. It dispatches on the active
// window's kind: server → ServerInfoCard today; query → whois is the
// deferred follow-on. It renders NOTHING for kinds with no context content.
// Built as a container (not a hardcoded server card) so future per-kind
// content grafts here without touching Shell's two rail mounts.

const selectedChannelMock = vi.hoisted(() => vi.fn<() => SelectedChannel | null>());
const networkBySlugMock = vi.hoisted(() => vi.fn<(slug: string) => Network | undefined>());

vi.mock("../lib/selection", () => ({
  selectedChannel: () => selectedChannelMock(),
}));

vi.mock("../lib/networks", () => ({
  networkBySlug: (slug: string) => networkBySlugMock(slug),
}));

const net: Network = {
  kind: "user",
  id: 7,
  slug: "libera",
  services_flavor: "atheme",
  nick: "vjt",
  ident: "vjt",
  realname: "VJT",
  connection_state: "connected",
  connection_state_reason: null,
  connection_state_changed_at: "2026-07-31T08:00:00.000Z",
  inserted_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

const sel = (kind: WindowKind, channelName: string): SelectedChannel => ({
  networkSlug: "libera",
  channelName,
  kind,
});

async function renderContainer() {
  const { default: RailContext } = await import("../RailContext");
  return render(() => <RailContext />);
}

describe("RailContext per-kind dispatch", () => {
  it("renders the ServerInfoCard on a server window when the network is live", async () => {
    selectedChannelMock.mockReturnValue(sel("server", "$server"));
    networkBySlugMock.mockReturnValue(net);
    await renderContainer();
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).toContain("libera");
  });

  it("renders nothing on a server window whose network is not live", async () => {
    selectedChannelMock.mockReturnValue(sel("server", "$server"));
    networkBySlugMock.mockReturnValue(undefined);
    await renderContainer();
    expect(screen.queryByTestId("rail-server-info")).toBeNull();
  });

  it("renders nothing on a channel window", async () => {
    selectedChannelMock.mockReturnValue(sel("channel", "#italia"));
    networkBySlugMock.mockReturnValue(net);
    await renderContainer();
    expect(screen.queryByTestId("rail-server-info")).toBeNull();
  });

  it("renders nothing on a query window (whois context is a deferred follow-on)", async () => {
    selectedChannelMock.mockReturnValue(sel("query", "alice"));
    networkBySlugMock.mockReturnValue(net);
    await renderContainer();
    expect(screen.queryByTestId("rail-server-info")).toBeNull();
  });

  it("renders nothing when no window is selected", async () => {
    selectedChannelMock.mockReturnValue(null);
    await renderContainer();
    expect(screen.queryByTestId("rail-server-info")).toBeNull();
  });
});
