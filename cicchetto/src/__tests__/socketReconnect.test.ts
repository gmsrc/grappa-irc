import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setConnectivityForTests } from "../lib/connectivity";
import {
  connectUnlessOffline,
  haltForOffline,
  kickReconnect,
  type ReconnectableSocket,
} from "../lib/socket";
import { __resetSocketHealthForTests, socketHealth } from "../lib/socketHealth";

// #119 (vjt refinement) — connectivity-driven reconnect kick. phoenix.js
// auto-reconnects natively with backoff; the DELTA we add is: on `online`
// force an IMMEDIATE reconnect (disconnect+connect) rather than waiting out
// the pending native backoff, and on `offline` disconnect() to halt futile
// retries on a dead network. These pure functions are the unit-testable seam
// (the real window listeners in socket.ts pass the live `_socket`).

function fakeSocket(connected: boolean): ReconnectableSocket & {
  connectCalls: number;
  disconnectCalls: number;
} {
  return {
    connected,
    connectCalls: 0,
    disconnectCalls: 0,
    isConnected(): boolean {
      return this.connected;
    },
    connect(): void {
      this.connectCalls++;
      this.connected = true;
    },
    disconnect(): void {
      this.disconnectCalls++;
      this.connected = false;
    },
  } as ReconnectableSocket & { connected: boolean; connectCalls: number; disconnectCalls: number };
}

beforeEach(() => {
  __setConnectivityForTests(true);
  __resetSocketHealthForTests();
});

afterEach(() => {
  __setConnectivityForTests(true);
  __resetSocketHealthForTests();
});

describe("kickReconnect (online)", () => {
  it("is a no-op when no socket has been built yet", () => {
    expect(() => kickReconnect(null)).not.toThrow();
  });

  it("does not tear down a socket that is already connected", () => {
    const s = fakeSocket(true);
    kickReconnect(s);
    expect(s.disconnectCalls).toBe(0);
    expect(s.connectCalls).toBe(0);
  });

  it("forces an immediate reconnect (disconnect+connect) when the socket is down", () => {
    const s = fakeSocket(false);
    kickReconnect(s);
    expect(s.disconnectCalls).toBe(1);
    expect(s.connectCalls).toBe(1);
  });
});

describe("haltForOffline (offline)", () => {
  it("is a no-op when no socket has been built yet", () => {
    expect(() => haltForOffline(null)).not.toThrow();
  });

  it("disconnects to halt futile retries on a dead network", () => {
    const s = fakeSocket(true);
    haltForOffline(s);
    expect(s.disconnectCalls).toBe(1);
    expect(s.connectCalls).toBe(0);
  });
});

// #1061 defect 1 — the offline halt must SURVIVE a foregrounding. The `offline`
// event fires exactly once, so an unguarded kick does not merely retry early:
// it re-arms phoenix's whole backoff ladder against a dead network with no
// second event left to stop it, permanently, until connectivity returns.
describe("kickReconnect while the device is offline (#1061)", () => {
  it("does not reconnect — one foreground must not un-do the offline halt", () => {
    const s = fakeSocket(false);
    __setConnectivityForTests(false);
    kickReconnect(s);
    expect(s.connectCalls).toBe(0);
  });

  it("does not even disconnect — an offline kick touches nothing at all", () => {
    // The bail is BEFORE the teardown, so a browser reporting a live socket
    // while `onLine` is false keeps it. Tearing it down would trade a possibly
    // working connection for a suppressed reconnect.
    const s = fakeSocket(false);
    __setConnectivityForTests(false);
    kickReconnect(s);
    expect(s.disconnectCalls).toBe(0);
  });

  it("resumes reconnecting the moment the device is back online", () => {
    // The guard must suppress, never strand: the same socket that was refused
    // while offline reconnects on the next kick once connectivity returns.
    const s = fakeSocket(false);
    __setConnectivityForTests(false);
    kickReconnect(s);
    expect(s.connectCalls).toBe(0);

    __setConnectivityForTests(true);
    kickReconnect(s);
    expect(s.connectCalls).toBe(1);
  });
});

// #1061 — the ONE door. Every production `connect()` passes through it, which
// is what makes the guard un-forgettable rather than merely present.
describe("connectUnlessOffline", () => {
  it("is a no-op when no socket has been built yet", () => {
    expect(() => connectUnlessOffline(null)).not.toThrow();
  });

  it("opens the socket and counts the attempt while online", () => {
    const s = fakeSocket(false);
    connectUnlessOffline(s);
    expect(s.connectCalls).toBe(1);
    expect(socketHealth().connectAttempts).toBe(1);
  });

  it("neither opens nor counts an attempt while offline", () => {
    // The tally must read as "attempts MADE" — a suppressed call that still
    // ticked the counter would make a held offline halt look like a live retry
    // loop in the hidden-episode probe, which is the one instrument that has
    // to be trusted for attribution.
    const s = fakeSocket(false);
    __setConnectivityForTests(false);
    connectUnlessOffline(s);
    expect(s.connectCalls).toBe(0);
    expect(socketHealth().connectAttempts).toBe(0);
  });
});
