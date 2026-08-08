import { beforeAll, describe, expect, it, vi } from "vitest";

// #1061 acceptance 1, in jsdom — "with the device offline, cicchetto does
// NOTHING: no WS connect attempts, no retry ladder, including after the app is
// foregrounded and backgrounded again while still offline, and including a
// cold start that begins offline."
//
// WHY ITS OWN FILE, and why ONE test rather than four. socket.ts registers its
// `online` / `offline` / `visibilitychange` listeners at module scope with
// anonymous handlers — nothing can detach them. So every `vi.resetModules()`
// re-import inside a file leaves a live listener behind, and one dispatched
// event then fires N handlers from N module instances, each closing over its
// OWN connectivity module (seeded from whatever `navigator.onLine` said at ITS
// import). A count taken after that measures the harness, not the code. One
// import per jsdom window is the only honest arrangement, and a file is the
// unit of jsdom window in vitest.
//
// The single test is not a bundle of unrelated assertions: it is one
// continuous offline session, which is exactly what the acceptance describes.
// Splitting it would need a second module instance to observe the second half.

const h = vi.hoisted(() => {
  const mockJoinPush = { receive: vi.fn() };
  mockJoinPush.receive.mockReturnValue(mockJoinPush);
  const mockChannel = { join: vi.fn(() => mockJoinPush), on: vi.fn(), leave: vi.fn() };
  const mockSocketInstance = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(false),
    channel: vi.fn(() => mockChannel),
    onOpen: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
  return { mockSocketInstance };
});

vi.mock("phoenix", () => {
  class MockSocket {
    constructor() {
      Object.assign(this, h.mockSocketInstance);
    }
  }
  return { Socket: MockSocket };
});

function stubOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("an offline session does nothing (#1061)", () => {
  beforeAll(async () => {
    // Offline BEFORE the import: connectivity.ts seeds its signal from
    // `navigator.onLine` at module-evaluation time, so this is a genuine cold
    // start that begins offline — not a signal poked after the socket already
    // dialled once.
    stubOnLine(false);
    localStorage.setItem("grappa-token", "tok-offline-session");
    await import("../lib/socket");
  });

  it("stays silent across foreground/background transitions, then connects when the network returns", () => {
    const connect = h.mockSocketInstance.connect;

    // Cold start, offline. The Socket is constructed (the `online` handler
    // needs an instance to kick) but never dialled.
    expect(connect).not.toHaveBeenCalled();

    // One foreground while still offline. This is the reported regression: an
    // unguarded kick re-arms phoenix's whole backoff ladder here, and because
    // the `offline` event has already fired and will not fire again, nothing
    // ever halts it. Once is enough to prove it — the ladder is permanent.
    setVisibility("visible");
    expect(connect).not.toHaveBeenCalled();

    // Background and foreground again, still offline. Repeated transitions
    // must not accumulate either.
    setVisibility("hidden");
    setVisibility("visible");
    setVisibility("hidden");
    setVisibility("visible");
    expect(connect).not.toHaveBeenCalled();

    // An `offline` event mid-session (a flap the browser reports twice) is
    // still a halt, never a dial.
    window.dispatchEvent(new Event("offline"));
    setVisibility("visible");
    expect(connect).not.toHaveBeenCalled();

    // The network returns. Suppression must not be stranding: the very same
    // socket dials exactly once, immediately.
    stubOnLine(true);
    window.dispatchEvent(new Event("online"));
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
