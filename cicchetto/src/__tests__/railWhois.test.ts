import { createEffect, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhoisBundle } from "../lib/api";

// #606 — rail whois store. Per-nick cache backing the query-window rail
// context (the deferred half of #474). DISTINCT from the single-slot
// `whoisCard.ts` store (owned by the user-issued `/whois` scrollback card):
// the rail fetches on select and must NOT clobber that store nor stack
// requests.
//
// The contract these tests pin: a nick the rail KNOWS is never asked about
// again (no freshness TTL — a WHOIS costs the operator's next send fake-lag
// budget and tells a +y peer it happened), while an ask that produced
// nothing — reply in flight, or an empty reply because the peer is offline —
// stands only for the retry window.
//
// Tests cover:
//   1. requestRailWhois issues WHOIS on first select.
//   2. a known nick is never re-asked, however old the bundle.
//   3. an unanswered ask is retried once the retry window lapses.
//   4. an EMPTY answer is not an answer: it is retried, not cached forever.
//   5. two rapid selects for the same nick issue ONE WHOIS.
//   6. A→B→A issues one WHOIS per nick, not three.
//   7. railWhoisFor is reactive + case-folded.
//   8. no live network id → no WHOIS, no throw.
//   9. identity rotation wipes the cache.
//  10. #373 — the cache follows a peer NICK instead of stranding it.

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
  avatar_url: null,
});

// What the server emits for a nick nobody holds: the accumulator drained by
// 318 never received a field, so every slot is null/false.
const emptyBundle = (target: string): WhoisBundle => ({
  ...bundle(target),
  user: null,
  host: null,
  realname: null,
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

  it("never re-issues WHOIS for an answered nick, however old the bundle", async () => {
    // The freshness TTL is deliberately gone. A WHOIS is not free and not
    // invisible: on bahamut it shares PRIVMSG's fake-lag budget (~5 close
    // commands and the ircd stops reading grappa's socket, so the operator's
    // next message waits in the kernel buffer), and a +y target is TOLD it
    // happened. A staleness refetch spends both on data nobody asked to
    // refresh, so an answered nick is answered for good.
    const { requestRailWhois, ingestRailWhois } = await import("../lib/railWhois");
    requestRailWhois("azzurra", "alice");
    ingestRailWhois("azzurra", "alice", bundle("alice"));
    vi.setSystemTime(T0 + 6 * 60 * 60 * 1000); // six hours later
    requestRailWhois("azzurra", "alice");
    expect(pushWhoisMock).toHaveBeenCalledTimes(1);
  });

  it("re-issues only for a request that was never answered (pending TTL lapsed)", async () => {
    const { requestRailWhois } = await import("../lib/railWhois");
    requestRailWhois("azzurra", "alice"); // no bundle ever arrives
    vi.setSystemTime(T0 + 31_000);
    requestRailWhois("azzurra", "alice");
    expect(pushWhoisMock).toHaveBeenCalledTimes(2);
  });

  it("retries an EMPTY answer later — an offline peer is not unknown forever", async () => {
    // bahamut answers a WHOIS for a nick nobody holds with 401 + 318, so the
    // bundle arrives carrying nothing. Caching that as "answered" would leave
    // the card reading "no WHOIS information returned" for the rest of the
    // session even after the peer signs on and messages you in that window.
    const { requestRailWhois, ingestRailWhois } = await import("../lib/railWhois");
    requestRailWhois("azzurra", "ghost");
    ingestRailWhois("azzurra", "ghost", emptyBundle("ghost"));
    requestRailWhois("azzurra", "ghost"); // straight away: still inside the retry window
    expect(pushWhoisMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 31_000);
    requestRailWhois("azzurra", "ghost");
    expect(pushWhoisMock).toHaveBeenCalledTimes(2);
  });

  it("issues ONE WHOIS for two rapid selects of the same nick (in-flight de-dupe)", async () => {
    const { requestRailWhois } = await import("../lib/railWhois");
    requestRailWhois("azzurra", "alice");
    requestRailWhois("azzurra", "alice"); // bundle not back yet
    expect(pushWhoisMock).toHaveBeenCalledTimes(1);
  });

  it("A→B→A issues one WHOIS per nick, not three", async () => {
    const { requestRailWhois, ingestRailWhois } = await import("../lib/railWhois");
    requestRailWhois("azzurra", "alice");
    ingestRailWhois("azzurra", "alice", bundle("alice"));
    requestRailWhois("azzurra", "bob");
    ingestRailWhois("azzurra", "bob", bundle("bob"));
    requestRailWhois("azzurra", "alice"); // back to A, already known
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
    requestRailWhois("azzurra", "carol"); // already known → no WHOIS
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

  it("a folded re-select (Alice → alice) issues one WHOIS", async () => {
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

  // #373 migration set (CLAUDE.md: a NEW nick-keyed store that skips it
  // strands its old-nick rows). Stranded, a rename makes the rail card go
  // blank and fires a SECOND upstream WHOIS on grappa's own IRC connection
  // microseconds before the operator's next send — measured on the testnet at
  // #379 of a full suite run, that WHOIS crossed bahamut's fake-lag threshold
  // and deferred the following PRIVMSG by 8s (the nick-follow-query e2e red).
  describe("renameRailWhois (#373 — the rail cache follows a peer NICK)", () => {
    it("moves the cached bundle old→new and relabels its target", async () => {
      const { ingestRailWhois, railWhoisFor, renameRailWhois } = await import("../lib/railWhois");
      ingestRailWhois("azzurra", "Guest87449", bundle("Guest87449"));
      renameRailWhois("azzurra", "Guest87449", "NickTemporaneo");
      expect(railWhoisFor("azzurra", "Guest87449")).toBeUndefined();
      expect(railWhoisFor("azzurra", "NickTemporaneo")?.host).toBe("Guest87449.host");
      // The card renders `bundle.target`; leaving the dead nick there would
      // label the live peer with the name it just abandoned.
      expect(railWhoisFor("azzurra", "NickTemporaneo")?.target).toBe("NickTemporaneo");
    });

    it("leaves the migrated entry fresh, so the post-rename select issues NO WHOIS", async () => {
      const { ingestRailWhois, renameRailWhois, requestRailWhois } = await import(
        "../lib/railWhois"
      );
      ingestRailWhois("azzurra", "Guest87449", bundle("Guest87449"));
      renameRailWhois("azzurra", "Guest87449", "NickTemporaneo");
      requestRailWhois("azzurra", "NickTemporaneo");
      expect(pushWhoisMock).not.toHaveBeenCalled();
    });

    it("is a no-op when the old nick holds nothing (a member rename, no query)", async () => {
      const { railWhoisFor, renameRailWhois, requestRailWhois } = await import("../lib/railWhois");
      renameRailWhois("azzurra", "stranger", "wanderer");
      expect(railWhoisFor("azzurra", "wanderer")).toBeUndefined();
      requestRailWhois("azzurra", "wanderer");
      expect(pushWhoisMock).toHaveBeenCalledTimes(1);
    });

    it("drops a still-pending entry instead of migrating the marker", async () => {
      // The in-flight reply keys on the OLD nick, so a migrated pending marker
      // would suppress the new nick's fetch while the answer lands on the dead
      // key — blank card, no recovery while the operator stays in the window.
      const { renameRailWhois, requestRailWhois, railWhoisFor } = await import("../lib/railWhois");
      requestRailWhois("azzurra", "Guest87449"); // issued, unanswered
      renameRailWhois("azzurra", "Guest87449", "NickTemporaneo");
      expect(railWhoisFor("azzurra", "Guest87449")).toBeUndefined();
      requestRailWhois("azzurra", "NickTemporaneo");
      expect(pushWhoisMock).toHaveBeenCalledTimes(2);
      expect(pushWhoisMock).toHaveBeenNthCalledWith(2, 1, "NickTemporaneo", null, "rail");
    });

    it("drops an entry that only holds an EMPTY answer", async () => {
      // Nothing known about this peer, so the rename has nothing to carry and
      // the new nick must be free to ask.
      const { ingestRailWhois, renameRailWhois, requestRailWhois, railWhoisFor } = await import(
        "../lib/railWhois"
      );
      ingestRailWhois("azzurra", "Guest87449", emptyBundle("Guest87449"));
      renameRailWhois("azzurra", "Guest87449", "NickTemporaneo");
      expect(railWhoisFor("azzurra", "Guest87449")).toBeUndefined();
      requestRailWhois("azzurra", "NickTemporaneo");
      expect(pushWhoisMock).toHaveBeenCalledTimes(1);
    });

    it("clears is_registered — 307 attests the NICK, not the person", async () => {
      const { ingestRailWhois, railWhoisFor, renameRailWhois } = await import("../lib/railWhois");
      ingestRailWhois("azzurra", "Guest87449", { ...bundle("Guest87449"), is_registered: true });
      renameRailWhois("azzurra", "Guest87449", "NickTemporaneo");
      expect(railWhoisFor("azzurra", "NickTemporaneo")?.is_registered).toBe(false);
      // Everything else describes the person and survives the rename.
      expect(railWhoisFor("azzurra", "NickTemporaneo")?.user).toBe("Guest87449_u");
    });

    it("keeps the existing new-nick entry on a collision (mirrors the cursor merge)", async () => {
      const { ingestRailWhois, railWhoisFor, renameRailWhois } = await import("../lib/railWhois");
      ingestRailWhois("azzurra", "old", bundle("old"));
      ingestRailWhois("azzurra", "new", bundle("new"));
      renameRailWhois("azzurra", "old", "new");
      expect(railWhoisFor("azzurra", "new")?.host).toBe("new.host");
      expect(railWhoisFor("azzurra", "old")).toBeUndefined();
    });

    it("folds both ends, so a window opened `guest` follows a NICK from `Guest`", async () => {
      const { ingestRailWhois, railWhoisFor, renameRailWhois } = await import("../lib/railWhois");
      ingestRailWhois("azzurra", "guest", bundle("guest"));
      renameRailWhois("azzurra", "Guest", "NEWNICK");
      expect(railWhoisFor("azzurra", "newnick")?.host).toBe("guest.host");
    });

    it("is a no-op on a case-only shift (old ≡ new under the fold)", async () => {
      const { ingestRailWhois, railWhoisFor, renameRailWhois } = await import("../lib/railWhois");
      ingestRailWhois("azzurra", "alice", bundle("alice"));
      renameRailWhois("azzurra", "alice", "Alice");
      expect(railWhoisFor("azzurra", "alice")?.target).toBe("alice");
    });
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
