import { createSignal, untrack } from "solid-js";
import type { WhoisBundle } from "./api";
import { identityScopedStore } from "./identityScopedStore";
import { networkIdBySlug } from "./networks";
import { normalizeNick } from "./nickEquals";
import { pushWhois } from "./socket";

// #606 — rail whois store: the per-nick WHOIS cache that backs the
// query-window rail context (the deferred half of #474). It is DELIBERATELY
// separate from the single-slot `whoisCard.ts` store:
//
//   * `whoisCard.ts` holds ONE bundle per network slug and is owned by the
//     user-issued `/whois` scrollback card (compose + UserContextMenu).
//   * this store holds one bundle PER NICK and is auto-populated when a
//     query window is selected — it must NOT clobber the single-slot store
//     (opening two queries would stomp the card) nor forge a scrollback
//     card the user never asked for.
//
// Fetch policy (issue #606 scope 2):
//   * fire a WHOIS when a query is selected (`requestRailWhois`);
//   * a per-nick TTL cache — re-selecting inside the TTL reuses the bundle
//     instead of re-hitting the ircd (rate-limit avoidance);
//   * in-flight de-dupe — fast window switching cannot stack requests.
//
// Both stores are fed by the SAME `whois_bundle` user-topic event. The
// server marks each bundle's origin (`source: "user" | "rail"`, #606
// option 2) so `userTopic.ts` can route without ambiguity: the single-slot
// store takes only `"user"` bundles; this store takes `"rail"` bundles PLUS
// a `"user"` bundle for the nick the rail is currently showing (a free
// refresh — which turns the shared-`whois_pending` collision into a cache
// hit rather than a race). `requestRailWhois` therefore issues its WHOIS
// tagged `"rail"`; `ingestRailWhois` just caches by nick.

// TTL a fetched rail whois stays fresh (ms). Re-selecting a query inside
// this window reuses the cached bundle rather than re-hitting the ircd.
const RAIL_WHOIS_TTL_MS = 60_000;
// A pending (issued, not-yet-answered) request is honoured for this long
// before a re-select re-issues, so a bundle that never arrives (peer
// offline, disconnect) does not wedge the nick forever.
const RAIL_WHOIS_PENDING_TTL_MS = 30_000;

type RailWhoisEntry = {
  /** Epoch ms of the last request (while pending) or ingest (once settled). */
  at: number;
  bundle: WhoisBundle | null;
  pending: boolean;
};

const exports_ = identityScopedStore((onIdentityChange) => {
  const [byNick, setByNick] = createSignal<Record<string, Record<string, RailWhoisEntry>>>({});

  onIdentityChange(() => setByNick({}));

  const put = (slug: string, key: string, entry: RailWhoisEntry): void => {
    setByNick((prev) => ({ ...prev, [slug]: { ...(prev[slug] ?? {}), [key]: entry } }));
  };

  // Reactive getter for the card — tracks `byNick` so the rail re-renders
  // when the bundle lands or is refreshed. Case-folded (#525) so `Alice`
  // and `alice` share one cache entry, matching the ircd + server fold.
  const railWhoisFor = (slug: string, nick: string): WhoisBundle | undefined =>
    byNick()[slug]?.[normalizeNick(nick)]?.bundle ?? undefined;

  // Called on query select (fetch-on-select). De-dupes: a fresh cached
  // bundle OR a live in-flight request short-circuits, so re-selecting a
  // query or fast A→B→A switching issues at most one WHOIS per nick.
  const requestRailWhois = (slug: string, nick: string): void => {
    const key = normalizeNick(nick);
    const now = Date.now();
    const entry = untrack(() => byNick()[slug]?.[key]);
    if (entry) {
      if (entry.pending && now - entry.at < RAIL_WHOIS_PENDING_TTL_MS) return; // in flight
      if (!entry.pending && entry.bundle && now - entry.at < RAIL_WHOIS_TTL_MS) return; // fresh
    }
    const networkId = networkIdBySlug(slug);
    if (networkId === undefined) return;
    // Keep any stale bundle visible while the refresh is in flight. Tagged
    // "rail" so the server marks the bundle's origin and userTopic routes it
    // here, NOT to the single-slot scrollback card (#606).
    put(slug, key, { at: now, bundle: entry?.bundle ?? null, pending: true });
    // Fire-and-forget: unlike the operator /whois (compose.ts awaits and
    // surfaces the reject inline), the rail auto-fetch was not user-initiated,
    // so a transient push reject (socket not connected, rate-limit) is
    // non-actionable and stays silent. The pending-TTL covers the retry — a
    // re-select after RAIL_WHOIS_PENDING_TTL_MS re-issues.
    void pushWhois(networkId, nick, null, "rail").catch(() => {});
  };

  // Feed the per-nick cache from an arriving `whois_bundle`. Clears the
  // pending marker (the request settled), so a later re-select falls back on
  // the TTL rule. Origin routing (which bundles reach here) is decided by the
  // caller in `userTopic.ts` off the server-marked `source`.
  const ingestRailWhois = (slug: string, target: string, bundle: WhoisBundle): void => {
    const key = normalizeNick(target);
    put(slug, key, { at: Date.now(), bundle, pending: false });
  };

  return { railWhoisFor, requestRailWhois, ingestRailWhois };
});

export const railWhoisFor = exports_.railWhoisFor;
export const requestRailWhois = exports_.requestRailWhois;
export const ingestRailWhois = exports_.ingestRailWhois;
