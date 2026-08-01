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
    const key = pendingKey(networkId, nick, token);
    const entry = pending.get(key);
    if (entry === undefined) return null;
    pending.delete(key);
    return {
      sourceKey: entry.sourceKey,
      sourceChannel: entry.sourceChannel,
      rttMs: nowMs - entry.sentAtMs,
    };
  };

  return { registerPing, resolvePing };
});

export const registerPing = exports_.registerPing;
export const resolvePing = exports_.resolvePing;
