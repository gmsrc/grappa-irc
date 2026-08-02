import type { ChannelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";
import { asciiFold } from "./nickEquals";

// #591 — the /ping reply-correlation table (the cic twin of shottino's
// (network, nick, stamp) table; see DESIGN_NOTES 2026-08-01). When the operator
// runs `/ping <nick>`, compose sends a CTCP PING carrying a client timestamp
// token and registers a pending entry here. The reply arrives as a server-typed
// `:notice` with `meta.ctcp_verb == "PING"` + `meta.ctcp_args == <token>`
// (cic NEVER parses \x01 — the server SSOT `Grappa.IRC.CTCP.verb_args/1`
// classified it). subscribe.ts resolves the token back to the SOURCE window and
// synthesizes the round-trip line there (irssi behavior), consuming the reply.
//
// Time is passed in explicitly (`sentAtMs` at register, `nowMs` at resolve) so
// the RTT delta is a pure subtraction — no wall clock inside this module, which
// is what makes it testable per the spec.
//
// Ephemeral + identity-scoped: cleared on logout / token rotation, like
// `inviteAck`. A ping in flight across a logout is simply forgotten — the RTT
// is an immediate cue, not an audit record.
//
// #637 leak guard — the pending entry is one-shot but was cleared ONLY by a
// matching reply or an identity change. An UNMATCHED /ping (a service that
// never echoes CTCP PING, a typo'd nick, a reply lost to a netsplit) therefore
// left an inert entry behind until logout — an unbounded growth path. Each
// register sweeps entries older than the horizon below (see registerPing), so
// the table is bounded by the pings issued within the last PENDING_TTL_MS.
// A reply that arrives past the horizon simply isn't correlated (it renders in
// its normal $server routing) — a CTCP round-trip that slow is not worth an RTT.
export const PENDING_TTL_MS = 60_000;

type PendingPing = {
  sourceKey: ChannelKey;
  sourceChannel: string;
  sentAtMs: number;
};

// Key on (network id, ASCII-folded nick, opaque token). The fold matches the
// server's CASEMAPPING=ascii nick fold (#525) so a reply from `Bob` claims a
// `/ping bob` entry; the token is opaque (never re-tokenized).
const pendingKey = (networkId: number, nick: string, token: string): string =>
  `${networkId}\x00${asciiFold(nick)}\x00${token}`;

const exports_ = identityScopedStore((onIdentityChange) => {
  const pending = new Map<string, PendingPing>();
  onIdentityChange(() => pending.clear());

  const registerPing = (
    networkId: number,
    nick: string,
    token: string,
    sourceKey: ChannelKey,
    sourceChannel: string,
    sentAtMs: number,
  ): void => {
    // #637 leak guard — evict entries older than the TTL horizon before
    // inserting. The horizon is measured against THIS register's sentAtMs (the
    // caller's clock), keeping the module wall-clock-free (spec). Bounds the
    // table to the pings issued within the last PENDING_TTL_MS, so a run of
    // unmatched /pings can no longer accumulate until logout.
    const horizon = sentAtMs - PENDING_TTL_MS;
    for (const [key, entry] of pending) {
      if (entry.sentAtMs <= horizon) pending.delete(key);
    }
    pending.set(pendingKey(networkId, nick, token), { sourceKey, sourceChannel, sentAtMs });
  };

  // Returns the source window + RTT for a reply that CLAIMS a pending entry,
  // deleting it (one-shot). Returns null for a reply that matches nothing —
  // the caller then leaves that notice to its normal routing, untouched.
  const resolvePing = (
    networkId: number,
    nick: string,
    token: string,
    nowMs: number,
  ): { sourceKey: ChannelKey; sourceChannel: string; rttMs: number } | null => {
    const resolve = (key: string, entry: PendingPing) => {
      pending.delete(key);
      return { sourceKey: entry.sourceKey, sourceChannel: entry.sourceChannel, rttMs: nowMs - entry.sentAtMs };
    };

    // Exact token match first — a well-behaved peer (or shottino) echoes the
    // token VERBATIM, so this is the precise, disambiguating path.
    const exactKey = pendingKey(networkId, nick, token);
    const exact = pending.get(exactKey);
    if (exact !== undefined) return resolve(exactKey, exact);

    // #637 — TOKEN-LESS reply fallback. Azzurra services (NickServ) answer a
    // CTCP PING with a BARE `\x01PING\x01`, dropping the token entirely — so the
    // exact key never matches and `/ping <service>` never rendered its RTT
    // (while `/ping <human>` did, the same session). ONLY when the reply carries
    // no token: fall back to the most-recent pending ping to THIS (network,
    // nick). Still scoped to the same ASCII-folded nick, so a reply cannot claim
    // another window's entry (the token invariant holds for non-empty tokens: a
    // wrong-but-present token still misses). Most-recent-wins is the sole
    // ambiguity, and only when the same nick is pinged twice while in flight.
    if (token !== "") return null;
    const nickPrefix = `${networkId}\x00${asciiFold(nick)}\x00`;
    let bestKey: string | undefined;
    let best: PendingPing | undefined;
    for (const [key, entry] of pending) {
      if (!key.startsWith(nickPrefix)) continue;
      if (best === undefined || entry.sentAtMs > best.sentAtMs) {
        best = entry;
        bestKey = key;
      }
    }
    if (best === undefined || bestKey === undefined) return null;
    return resolve(bestKey, best);
  };

  return { registerPing, resolvePing };
});

export const registerPing = exports_.registerPing;
export const resolvePing = exports_.resolvePing;
