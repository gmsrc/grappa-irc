import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CrtSplash from "../CrtSplash";

// #134 — retro CRT loading splash. The splash is the LOADING-ONLY
// content of the Shell main-pane `<Switch fallback>`: it renders while
// cic is still booting (before `/me` resolves and the channels resource
// settles) and HANDS OFF to the home window the instant load completes.
//
// A transient loading screen is e2e-hostile (gone the moment the page
// finishes loading), so the honest proof level is this component test:
// drive the loading predicate directly and assert (a) the CRT splash +
// its boot/LOADING text render while loading, and (b) nothing renders
// once loaded (the hand-off contract). The loading predicate mirrors
// Shell's cold-load auto-select wait EXACTLY: `!user()` (/, me not yet
// resolved) OR `channelsBySlug() === undefined` (resource still loading;
// a resolved `{}` is truthy and means "loaded, no channels yet").
//
// Mocks: networks.ts (user + channelsBySlug signals).

const userMock = vi.fn<() => unknown>(() => null);
const networksMock = vi.fn<() => unknown>(() => undefined);
const channelsBySlugMock = vi.fn<() => unknown>(() => undefined);

vi.mock("../lib/networks", () => ({
  // #1861 — casemappingForSlug (lib/casemapping.ts) resolves the fold
  // through this map, so the mock has to carry it.
  networkIdBySlug: () => undefined,
  user: () => userMock(),
  networks: () => networksMock(),
  channelsBySlug: () => channelsBySlugMock(),
}));

const USER = { kind: "visitor", id: "v1", nick: "guest", network_slug: "azzurra" };

function stageLine(id: string): HTMLElement {
  const el = document.querySelector(`[data-stage="${id}"]`);
  if (el === null) throw new Error(`no boot-register line for stage "${id}"`);
  return el as HTMLElement;
}

describe("CrtSplash (#134 — retro CRT loading splash)", () => {
  beforeEach(() => {
    userMock.mockReturnValue(null);
    networksMock.mockReturnValue(undefined);
    channelsBySlugMock.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the CRT splash while /me is unresolved (cold boot)", () => {
    userMock.mockReturnValue(null);
    channelsBySlugMock.mockReturnValue(undefined);
    render(() => <CrtSplash />);

    expect(screen.getByTestId("crt-splash")).toBeInTheDocument();
    // The retro boot/LOADING text is the visible payload — assert it so a
    // future refactor that drops the text fails loudly (no vacuous green).
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("still renders while the channels resource is loading (user resolved, channels undefined)", () => {
    userMock.mockReturnValue(USER);
    networksMock.mockReturnValue([]);
    channelsBySlugMock.mockReturnValue(undefined);
    render(() => <CrtSplash />);

    expect(screen.getByTestId("crt-splash")).toBeInTheDocument();
  });

  // #687 — the register must say WHERE the boot is, not merely exist. A
  // test that asserts the three lines are present would pass against a
  // register hard-coded to "done", so every case below pins the done
  // FLAG against a resource state, in both directions.
  it("prints one un-done line per stage while nothing has resolved", () => {
    render(() => <CrtSplash />);

    expect(screen.getByTestId("crt-boot-stages").children).toHaveLength(3);

    for (const id of ["me", "networks", "channels"]) {
      expect(stageLine(id).dataset.done).toBe("false");
      expect(stageLine(id).textContent).not.toMatch(/done/);
    }

    expect(stageLine("me").textContent).toBe("fetching my info...");
  });

  it("marks a stage done the moment its resource resolves, and only that stage", () => {
    // /me answered; the networks fetch it unblocks is still in flight.
    userMock.mockReturnValue(USER);
    networksMock.mockReturnValue(undefined);
    channelsBySlugMock.mockReturnValue(undefined);
    render(() => <CrtSplash />);

    expect(stageLine("me").dataset.done).toBe("true");
    expect(stageLine("me").textContent).toBe("fetching my info... done");

    // The stall is now named: this is the line the user is waiting on.
    expect(stageLine("networks").dataset.done).toBe("false");
    expect(stageLine("networks").textContent).toBe("fetching networks...");
    expect(stageLine("channels").dataset.done).toBe("false");
  });

  it("marks the networks stage done on a resolved EMPTY list, not just a populated one", () => {
    // `[]` is a resolved resource — a subject with no networks has
    // finished that stage. Reading it as "still fetching" would leave
    // the register stuck on a boot that is in fact past it.
    userMock.mockReturnValue(USER);
    networksMock.mockReturnValue([]);
    channelsBySlugMock.mockReturnValue(undefined);
    render(() => <CrtSplash />);

    expect(stageLine("networks").dataset.done).toBe("true");
    expect(stageLine("channels").dataset.done).toBe("false");
  });

  it("hands off — renders nothing once both /me and channels have loaded", () => {
    userMock.mockReturnValue(USER);
    networksMock.mockReturnValue([]);
    // A resolved empty object is truthy: load is DONE, there just are no
    // channels yet. The splash must hand off (render null), not linger.
    channelsBySlugMock.mockReturnValue({});
    render(() => <CrtSplash />);

    expect(screen.queryByTestId("crt-splash")).toBeNull();
  });
});
