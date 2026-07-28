// Foreground mirror of the server push predicate
// `Grappa.Push.Triggers.should_notify?/4` (PWA icon badge, 2026-06-21).
//
// Why a client-side copy exists. The badge's authoritative values come
// from the server (the `/me` seed, the `read_cursor_set` broadcast, and
// the push payload all carry a server-computed count). But the DESKTOP
// `document.title` must also move the instant a notify-worthy message
// arrives in an UNFOCUSED tab — before any read-cursor settle round-trips
// to the server. That single increment needs the same predicate the
// server uses, evaluated locally.
//
// One predicate, two ports. To stop this copy drifting from the Elixir
// original, BOTH run against ONE shared truth-table fixture
// (`shouldNotifyTruthTable.json`): the vitest `pushTriggers.test.ts` and
// the ExUnit `should_notify_parity_test.exs` consume the identical cases.
// Add a branch → add a row → both suites pick it up. Same discipline as
// the wireTypes parity gate.
//
// The mention sub-predicate is NOT reimplemented — it delegates to
// `matchesWatchlist` from `mentionMatch.ts`, the established mirror of
// `Grappa.Mentions.mentioned?/3` (own nick ∪ highlight patterns). #370 —
// the SAME predicate now drives the in-message visual highlight, so the
// notify-match and the visual-match can never diverge again.

import { type MessageKind, NOTIFY_KINDS } from "./api";
import { canonicalChannel } from "./channelKey";
import { matchesWatchlist } from "./mentionMatch";
import { asciiFold } from "./nickEquals";
import type { NotificationPrefs } from "./userSettings";

// Minimal structural shape the predicate needs — a subset of the wire
// scrollback message. Kept narrow so the truth-table JSON maps directly
// and call sites can pass any message-like object.
export type ShouldNotifyMessage = {
  kind: string;
  channel: string;
  sender: string;
  body: string | null;
};

/**
 * Returns true when `message` should produce a notification for the
 * operator whose IRC nick is `ownNick`, given `prefs` + `patterns`.
 *
 * Faithful transcription of `Grappa.Push.Triggers.should_notify?/4`:
 *   1. kind gate — only the shared `NOTIFY_KINDS` SSOT (privmsg|action,
 *      the "notify" subset of api's CONTENT_KINDS, #395) → everything else
 *      false. NOTICE (services chatter) counts as unread but never notifies.
 *   2. DM (channel === ownNick): private_messages_all OR
 *      asciiFold(sender) in private_messages_only (mirrors the
 *      server's `canonical_nick(sender) in ...`).
 *   3. channel: channel_messages_all OR canonicalChannel(channel) in
 *      channel_messages_only OR (channel_mentions AND mention).
 */
export function shouldNotify(
  message: ShouldNotifyMessage,
  ownNick: string,
  prefs: NotificationPrefs,
  patterns: string[],
): boolean {
  // `message.kind` is a bare string (the truth-table JSON / any message-like
  // object); cast to MessageKind for the typed-set membership check — a
  // non-member string just returns false. Same `.has(x as MessageKind)`
  // convention as `wireNarrow.ts`.
  if (!NOTIFY_KINDS.has(message.kind as MessageKind)) return false;

  if (message.channel === ownNick) {
    return dmMatch(message, prefs);
  }
  return channelMatch(message, prefs, ownNick, patterns);
}

function dmMatch(message: ShouldNotifyMessage, prefs: NotificationPrefs): boolean {
  // rfc1459 fold on the sender, mirroring the server's
  // `Identifier.canonical_nick(sender) in private_messages_only` — the
  // whitelist entries are stored server-folded. A bare `.toLowerCase()`
  // here would miss a bracket-range nick the server folds.
  return (
    prefs.private_messages_all || prefs.private_messages_only.includes(asciiFold(message.sender))
  );
}

function channelMatch(
  message: ShouldNotifyMessage,
  prefs: NotificationPrefs,
  ownNick: string,
  patterns: string[],
): boolean {
  return (
    // canonicalChannel (sigil-gated rfc1459 fold), NOT a bare toLowerCase,
    // mirroring the server's `Identifier.canonical_channel(channel) in
    // channel_messages_only` — the whitelist is stored channel-folded, and
    // bahamut folds `[ ] \ ~` in channel names too, so `#chan[1]` and
    // `#chan{1}` are ONE channel. A bare toLowerCase leaves the brackets
    // unfolded and misses a whitelisted `#chan{1}` when the channel is
    // `#chan[1]`.
    prefs.channel_messages_all ||
    prefs.channel_messages_only.includes(canonicalChannel(message.channel)) ||
    (prefs.channel_mentions && matchesWatchlist(message.body, ownNick, patterns))
  );
}
