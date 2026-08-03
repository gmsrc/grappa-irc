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
// Fetch policy (issue #606 scope 2, revised):
//   * ONE WHOIS per nick, on FIRST select (`requestRailWhois`). Cached for
//     the life of the identity — there is NO staleness refetch;
//   * in-flight de-dupe — fast window switching cannot stack requests.
//
// The freshness TTL this store shipped with is deliberately GONE. It was not
// a cost problem: on bahamut a WHOIS and a PRIVMSG carry the same fake-lag
// flag and the same `since += 2 + len/120` (src/parse.c:236). The problem is
// the CEILING — `s_bsd.c:1657` reads a client's socket only while
// `since - now < 10`, so ~5 closely-spaced commands and the ircd STOPS
// READING grappa's socket; whatever the operator sends next sits in the
// kernel buffer until `since` drains. A TTL invites exactly that burst
// (cycle back through N query windows after a minute and every one refires),
// and the operator's next message pays for it. Not refetching removes the
// burst by construction instead of policing it — the cheapest rate limiter
// is the command you never send.
//
// There is a second, stronger reason, and it is not about cost at all: a
// WHOIS is VISIBLE TO THE PERSON IT NAMES. A target carrying umode +y is sent
// "<nick> is doing a WHOIS on you" (bahamut src/s_user.c:2200 — a
// `sendto_one` to the target, not an oper broadcast). Every automatic refetch
// is therefore noise delivered onto a peer for a refresh nobody requested.
// The rule this store is built against:
//
//     NEVER send a WHOIS the user did not initiate.
//
// Accepted tradeoff, stated plainly: the card is fetched once and is NOT
// refreshable. `idle_seconds` / `signon` age badly (host, realname, channels
// do not), so a long-lived rail card will show a stale idle clock. The one
// thing that does refresh it is the operator's own `/whois <peer>` —
// `userTopic` routes a `source: "user"` bundle for the shown nick here too —
// and that is a WHOIS the user asked for.
//
// Both stores are fed by the SAME `whois_bundle` user-topic event. The
// server marks each bundle's origin (`source: "user" | "rail"`, #606
// option 2) so `userTopic.ts` can route without ambiguity: the single-slot
// store takes only `"user"` bundles; this store takes `"rail"` bundles PLUS
// a `"user"` bundle for the nick the rail is currently showing (a free
// refresh — which turns the shared-`whois_pending` collision into a cache
// hit rather than a race). `requestRailWhois` therefore issues its WHOIS
// tagged `"rail"`; `ingestRailWhois` just caches by nick.

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

  // Called on query select. Issues at most ONE WHOIS per nick per identity:
  // an already-answered nick short-circuits FOREVER (no staleness rule), and
  // a live in-flight request short-circuits until the pending TTL lapses, so
  // fast A→B→A switching cannot stack requests. A WHOIS is visible to the
  // person it names — a target carrying umode +y is told "<nick> is doing a
  // WHOIS on you" (bahamut src/s_user.c:2200) — so every avoided refetch is
  // noise a peer does not receive, not merely a command grappa does not send.
  const requestRailWhois = (slug: string, nick: string): void => {
    const key = normalizeNick(nick);
    const now = Date.now();
    const entry = untrack(() => byNick()[slug]?.[key]);
    if (entry) {
      if (entry.pending && now - entry.at < RAIL_WHOIS_PENDING_TTL_MS) return; // in flight
      if (entry.bundle) return; // answered once — never re-asked
    }
    const networkId = networkIdBySlug(slug);
    if (networkId === undefined) return;
    // Reaching here means there is nothing cached (a bundle would have
    // returned above), so this only ever marks a first fetch or a retry after
    // an unanswered one.
    put(slug, key, { at: now, bundle: null, pending: true });
    // Fire-and-forget: unlike the operator /whois (compose.ts awaits and
    // surfaces the reject inline), the rail auto-fetch was not user-initiated,
    // so a transient push reject (socket not connected, rate-limit) is
    // non-actionable and stays silent. The pending-TTL covers the retry — a
    // re-select after RAIL_WHOIS_PENDING_TTL_MS re-issues.
    void pushWhois(networkId, nick, null, "rail").catch(() => {});
  };

  // Feed the per-nick cache from an arriving `whois_bundle`. Clears the
  // pending marker (the request settled) and settles the nick for good — the
  // only later writes are a user-issued `/whois` refresh (routed here by
  // `userTopic.ts` off the server-marked `source`) and a #373 rename.
  const ingestRailWhois = (slug: string, target: string, bundle: WhoisBundle): void => {
    const key = normalizeNick(target);
    put(slug, key, { at: Date.now(), bundle, pending: false });
  };

  // #373 — a peer renamed: move its cached bundle old→new. This cache is a
  // nick-keyed store, so it belongs to the rename migration set (CLAUDE.md:
  // one that skips it strands its old-nick rows) alongside the scrollback,
  // the read cursor and the selection. Stranding it costs three ways: the
  // card blanks, `requestRailWhois` misses on the new nick and re-asks the
  // ircd (one more closely-spaced command on a connection whose next PRIVMSG
  // then waits behind it — measured at 8s), and that re-ask puts "<nick> is
  // doing a WHOIS on you" in front of a +y peer for the crime of renaming.
  // A rename is an identity MIGRATION, so the bundle describes the same
  // person — host, realname, channels all still hold — and it is relabelled
  // rather than refetched.
  //
  // ONLY an answered entry migrates. A still-pending one carries no bundle to
  // move, and its reply keys on the OLD nick (`userTopic` routes on the wire
  // `target`), so migrating the pending MARKER would suppress the new nick's
  // fetch while the answer lands on the dead key — a card blank until the
  // pending TTL lapses AND the selection identity changes, which it will not
  // while the operator sits in the renamed window. Dropping it instead lets
  // the new nick fetch once, which is the right outcome: nothing is known
  // about this peer yet, so there is nothing a rename could carry over.
  //
  // Merge rule mirrors `renameReadCursorChannel`: an entry already under the
  // new nick wins (it is the fresher observation of that identity).
  const renameRailWhois = (slug: string, oldNick: string, newNick: string): void => {
    const oldKey = normalizeNick(oldNick);
    const newKey = normalizeNick(newNick);
    if (oldKey === newKey) return;
    setByNick((prev) => {
      const net = prev[slug];
      if (net === undefined || !(oldKey in net)) return prev;
      const { [oldKey]: moved, ...rest } = net;
      if (moved === undefined || moved.bundle === null || newKey in rest) {
        return { ...prev, [slug]: rest };
      }
      const carried = moved.bundle;
      return {
        ...prev,
        [slug]: {
          ...rest,
          [newKey]: {
            at: moved.at,
            // `pending` is dropped with the old key: any refresh still in
            // flight will answer to the old nick, so the new key is settled.
            pending: false,
            // 307 RPL_WHOISREGNICK is "identified for THIS nick", not for the
            // person — the one field a rename genuinely invalidates. Carrying
            // it would badge the renamed peer "registered" on no evidence.
            bundle: { ...carried, target: newNick, is_registered: false },
          },
        },
      };
    });
  };

  return { railWhoisFor, requestRailWhois, ingestRailWhois, renameRailWhois };
});

export const railWhoisFor = exports_.railWhoisFor;
export const requestRailWhois = exports_.requestRailWhois;
export const ingestRailWhois = exports_.ingestRailWhois;
export const renameRailWhois = exports_.renameRailWhois;
