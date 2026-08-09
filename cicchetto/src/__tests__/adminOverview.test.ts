import type { Channel } from "phoenix";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminOverviewWireT } from "../lib/wireTypes";

// #1073 / #1075 — adminOverview store: the `"overview"` push that feeds the
// admin top bar's left group. Rides the SAME admin channel as adminEvents and
// sessionLog (`grappa:admin:events`); the wiring is installed via
// `installAdminOverview(channel)`, called from adminEvents.ts's
// `installAdminEvents` — one channel, three consumers, no second WS join.
//
// Unlike the two ring stores, this one holds a SNAPSHOT: each tick replaces
// the previous value rather than accumulating, because the server samples the
// same five facts every interval.

import { adminOverview, installAdminOverview, resetAdminOverview } from "../lib/adminOverview";

const snapshot = (overrides: Partial<AdminOverviewWireT>): AdminOverviewWireT => ({
  sessions: 3,
  visitors: { total: 5, live: 2 },
  hostname: "m42",
  loadavg: 0.42,
  version: "0.15.0",
  ...overrides,
});

// Fake Channel that captures the `overview` handler so the test can fire
// payloads at will. Matches the slim slice of phoenix.js's Channel API the
// production module touches (mirror of sessionLog.test.ts's makeFakeChannel).
function makeFakeChannel(): {
  channel: Channel;
  fire: (payload: AdminOverviewWireT) => void;
  fireRaw: (payload: unknown) => void;
  handlerNames: () => string[];
} {
  let cb: ((p: unknown) => void) | null = null;
  const names: string[] = [];
  const channel = {
    on: (name: string, handler: unknown) => {
      names.push(name);
      if (name === "overview") cb = handler as (p: unknown) => void;
      return 0;
    },
    leave: () => ({ receive: () => ({ receive: () => undefined }) }),
  } as unknown as Channel;
  return {
    channel,
    fire: (p) => cb?.(p),
    fireRaw: (p) => cb?.(p),
    handlerNames: () => names,
  };
}

beforeEach(() => {
  resetAdminOverview();
  expect(adminOverview()).toBeNull();
});

describe("adminOverview store — install + ingest", () => {
  it("is null until the first push lands", () => {
    const fake = makeFakeChannel();
    installAdminOverview(fake.channel);
    expect(adminOverview()).toBeNull();
    expect(fake.handlerNames()).toContain("overview");
  });

  it("holds the pushed snapshot", () => {
    const fake = makeFakeChannel();
    installAdminOverview(fake.channel);

    fake.fire(snapshot({}));

    expect(adminOverview()).toEqual(snapshot({}));
  });

  it("REPLACES on the next tick rather than accumulating", () => {
    // The server re-samples all five facts every interval, so the store is a
    // snapshot and not a ring: the bar must show the latest reading, and an
    // accumulating store would either grow unbounded or show a stale head.
    const fake = makeFakeChannel();
    installAdminOverview(fake.channel);

    fake.fire(snapshot({ sessions: 1, loadavg: 0.1 }));
    fake.fire(snapshot({ sessions: 9, loadavg: 3.5 }));

    expect(adminOverview()?.sessions).toBe(9);
    expect(adminOverview()?.loadavg).toBe(3.5);
  });

  it("accepts a null loadavg — an unreachable sampler is a valid reading", () => {
    // The load-bearing case. `loadavg` is `float() | nil` on the wire because
    // "cannot measure" is a different fact from "idle"; a narrower that
    // demanded a number would drop the WHOLE payload whenever the sampler is
    // down, blanking a bar whose other four stats are perfectly good.
    const fake = makeFakeChannel();
    installAdminOverview(fake.channel);

    fake.fire(snapshot({ loadavg: null }));

    expect(adminOverview()).not.toBeNull();
    expect(adminOverview()?.loadavg).toBeNull();
    expect(adminOverview()?.hostname).toBe("m42");
  });
});

describe("adminOverview store — lifecycle", () => {
  it("install is idempotent for the same channel reference", () => {
    const fake = makeFakeChannel();
    installAdminOverview(fake.channel);
    installAdminOverview(fake.channel);
    expect(fake.handlerNames().filter((n) => n === "overview").length).toBe(1);
  });

  it("reset clears the store and allows a fresh install on a new channel", () => {
    const first = makeFakeChannel();
    installAdminOverview(first.channel);
    first.fire(snapshot({ hostname: "first" }));
    expect(adminOverview()?.hostname).toBe("first");

    resetAdminOverview();
    expect(adminOverview()).toBeNull();

    const second = makeFakeChannel();
    installAdminOverview(second.channel);
    second.fire(snapshot({ hostname: "second" }));
    expect(adminOverview()?.hostname).toBe("second");
  });

  it("a push on the OLD channel after reset is ignored", () => {
    const first = makeFakeChannel();
    installAdminOverview(first.channel);
    resetAdminOverview();

    first.fire(snapshot({ hostname: "stale" }));

    expect(adminOverview()).toBeNull();
  });
});

describe("adminOverview store — narrower boundary", () => {
  it("drops a malformed payload without crashing", () => {
    const fake = makeFakeChannel();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installAdminOverview(fake.channel);

    expect(() => fake.fireRaw({ sessions: "three", hostname: "m42" })).not.toThrow();

    expect(adminOverview()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps the last good reading when a malformed push arrives", () => {
    // Nulling the store on a bad tick would blank the bar on every skewed
    // push. A stale-but-true reading beats a blank one, and the next good
    // tick is one interval away.
    const fake = makeFakeChannel();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installAdminOverview(fake.channel);

    fake.fire(snapshot({ hostname: "good" }));
    fake.fireRaw({ nonsense: true });

    expect(adminOverview()?.hostname).toBe("good");
  });

  it("rejects a payload whose visitors pair is missing or wrong-shaped", () => {
    const fake = makeFakeChannel();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installAdminOverview(fake.channel);

    fake.fireRaw({ ...snapshot({}), visitors: 5 });
    fake.fireRaw({ ...snapshot({}), visitors: { total: 5 } });
    fake.fireRaw(null);

    expect(adminOverview()).toBeNull();
  });
});
