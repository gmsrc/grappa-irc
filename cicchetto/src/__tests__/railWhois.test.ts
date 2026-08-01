import { createEffect, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhoisBundle } from "../lib/api";

// #606 — rail whois store. Per-nick TTL cache + in-flight de-dupe that
// backs the query-window rail context (the deferred half of #474). It is
// DISTINCT from the single-slot `whoisCard.ts` store (which stays owned by
// the user-issued `/whois` scrollback card): the rail auto-fetches on
// select and must NOT clobber that store nor stack requests.
//
// Tests cover:
//   1. requestRailWhois issues WHOIS on first select.
//   2. re-select inside the TTL (bundle cached) does NOT re-issue.
//   3. re-select after the TTL re-issues.
//   4. two rapid selects for the same nick issue ONE WHOIS (in-flight).
//   5. A→B→A inside the TTL issues one WHOIS per nick, not three.
//   6. ingestRailWhois reports whether the bundle satisfied a rail request.
//   7. railWhoisFor is reactive + case-folded.
//   8. no live network id → no WHOIS, no throw.
//   9. identity rotation wipes the cache.

vi.mock("../lib/auth", async () => {
  const { createSignal } = await import("solid-js");
  const [tok, setTok] = createSignal<string | null>("tokA");
  return { token: tok, setToken: setTok };
});

const pushWhoisMock = vi.hoisted(() =>
  vi.fn<(id: number, nick: string, server: string | null, origin: string) => Promise<void>>(),
);
const networkIdBySlugMock = vi.hoisted(() => vi.fn<(slug: string) => number | undefined>());

vi.mock("../lib/socket", () => ({
  pushWhois: (id: number, nick: string, server: string | null, origin: string) =>
    pushWhoisMock(id, nick, server, origin),
}));

vi.mock("../lib/networks", () => ({
  networkIdBySlug: (slug: string) => networkIdBySlugMock(slug),
}));

const T0 = 1_700_000_000_000;

const bundle = (target: string): WhoisBundle => ({
  network: "azzurra",
  target,
  source: "rail",
  user: `${target}_u`,
  host: `${target}.host`,
  realname: null,
  server: null,
  server_info: null,
  is_operator: false,
  oper_text: null,
  idle_seconds: null,
  signon: null,
  channels: null,
  using_ssl: false,
  is_registered: false,
  is_admin: false,
  is_services_admin: false,
  is_helper: false,
  is_chanop: false,
  is_agent: false,
  is_java: false,
  umodes: null,
  away_message: null,
  actually_host: null,
  actually_ip: null,
  account: null,
  secure: false,
  secure_cipher: null,
  certfp: null,
  extra_lines: null,
});

beforeEach(() => {
  vi.resetModules();
  pushWhoisMock.mockReset();
  pushWhoisMock.mockResolvedValue(undefined);
  networkIdBySlugMock.mockReset();
  networkIdBySlugMock.mockImplementation((slug: string) => (slug === "azzurra" ? 1 : undefined));
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("railWhois", () => {
  it("requestRailWhois issues WHOIS(networkId, nick, null) tagged origin 'rail'", async () => {
    const { requestRailWhois } = await import("../lib/railWhois");
    requestRailWhois("azzurra", "alice");
    expect(pushWhoisMock).toHaveBeenCalledTimes(1);
    expect(pushWhoisMock).toHaveBeenCalledWith(1, "alice", null, "rail");
  });

  it("does NOT re-issue WHOIS on a re-select inside the TTL once a bundle is cached", async () => {
    const { requestRailWhois, ingestRailWhois } = await import("../lib/railWhois");
    requestRailWhois("azzurra", "alice");
    ingestRailWhois("azzurra", "alice", bundle("alice"));
    vi.setSystemTime(T0 + 30_000); // still inside the 60s TTL
    requestRailWhois("azzurra", "alice");
    expect(pushWhoisMock).toHaveBeenCalledTimes(1);
  });

  it("re-issues WHOIS on a re-select after the TTL lapses", async () => {
    const { requestRailWhois, ingestRailWhois } = await import("../lib/railWhois");
    requestRailWhois("azzurra", "alice");
    ingestRailWhois("azzurra", "alice", bundle("alice"));
    vi.setSystemTime(T0 + 61_000); // past the 60s TTL
    requestRailWhois("azzurra", "alice");
    expect(pushWhoisMock).toHaveBeenCalledTimes(2);
  });

  it("issues ONE WHOIS for two rapid selects of the same nick (in-flight de-dupe)", async () => {
    const { requestRailWhois } = await import("../lib/railWhois");
    requestRailWhois("azzurra", "alice");
    requestRailWhois("azzurra", "alice"); // bundle not back yet
    expect(pushWhoisMock).toHaveBeenCalledTimes(1);
  });

  it("A→B→A inside the TTL issues one WHOIS per nick, not three", async () => {
    const { requestRailWhois, ingestRailWhois } = await import("../lib/railWhois");
    requestRailWhois("azzurra", "alice");
    ingestRailWhois("azzurra", "alice", bundle("alice"));
    requestRailWhois("azzurra", "bob");
    ingestRailWhois("azzurra", "bob", bundle("bob"));
    requestRailWhois("azzurra", "alice"); // back to A, still fresh
    expect(pushWhoisMock).toHaveBeenCalledTimes(2);
    expect(pushWhoisMock).toHaveBeenNthCalledWith(1, 1, "alice", null, "rail");
    expect(pushWhoisMock).toHaveBeenNthCalledWith(2, 1, "bob", null, "rail");
  });

  it("ingestRailWhois caches a bundle even for a nick the rail never requested", async () => {
    // Option 2's user-refresh path: userTopic feeds a `source: user` bundle
    // for the currently-shown nick into the rail cache, with no prior rail
    // request. The cache accepts it and it satisfies the TTL de-dupe after.
    const { ingestRailWhois, requestRailWhois, railWhoisFor } = await import("../lib/railWhois");
    ingestRailWhois("azzurra", "carol", bundle("carol"));
    expect(railWhoisFor("azzurra", "carol")?.target).toBe("carol");
    requestRailWhois("azzurra", "carol"); // fresh cache → no WHOIS
    expect(pushWhoisMock).not.toHaveBeenCalled();
  });

  it("railWhoisFor returns the ingested bundle, reactively and case-folded", async () => {
    const { requestRailWhois, ingestRailWhois, railWhoisFor } = await import("../lib/railWhois");
    const seen: (string | undefined)[] = [];
    createRoot(() => {
      createEffect(() => seen.push(railWhoisFor("azzurra", "Alice")?.target));
    });
    expect(seen.at(-1)).toBeUndefined();
    requestRailWhois("azzurra", "Alice");
    ingestRailWhois("azzurra", "alice", bundle("alice")); // folded key matches "Alice"
    await Promise.resolve();
    expect(railWhoisFor("azzurra", "ALICE")?.target).toBe("alice");
    expect(seen.at(-1)).toBe("alice");
  });

  it("a folded re-select (Alice → alice) inside the TTL issues one WHOIS", async () => {
    const { requestRailWhois, ingestRailWhois } = await import("../lib/railWhois");
    requestRailWhois("azzurra", "Alice");
    ingestRailWhois("azzurra", "Alice", bundle("Alice"));
    requestRailWhois("azzurra", "alice");
    expect(pushWhoisMock).toHaveBeenCalledTimes(1);
  });

  it("does not issue WHOIS (and does not throw) when the network has no live id", async () => {
    const { requestRailWhois } = await import("../lib/railWhois");
    requestRailWhois("ghost", "alice");
    expect(pushWhoisMock).not.toHaveBeenCalled();
  });

  it("wipes the cache on identity rotation (logout/token change)", async () => {
    const { requestRailWhois, ingestRailWhois, railWhoisFor } = await import("../lib/railWhois");
    const auth = await import("../lib/auth");
    requestRailWhois("azzurra", "alice");
    ingestRailWhois("azzurra", "alice", bundle("alice"));
    expect(railWhoisFor("azzurra", "alice")).toBeDefined();
    (auth as unknown as { setToken: (t: string | null) => void }).setToken("tokB");
    await Promise.resolve();
    expect(railWhoisFor("azzurra", "alice")).toBeUndefined();
  });
});
