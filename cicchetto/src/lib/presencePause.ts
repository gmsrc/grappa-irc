// #1680 — which channels are currently paused, and what "paused" is allowed
// to swallow.
//
// Composes `presenceCooldown.ts` (the WINDOW: when does a blurred channel
// become paused) with the two decisions the window deliberately does not
// make: which channels are paused right now, and which events a paused
// channel drops.
//
// WHY THIS DROPS AT THE DISPATCH EDGE AND NOT BY LEAVING THE TOPIC
//
// The obvious "pause" is to leave the per-channel Phoenix topic. Measured, it
// is wrong: that topic is not a presence feed, it is the window's whole
// inbound. `Grappa.Session.Persistor` broadcasts the MESSAGES on it
// (persistor.ex:107), alongside `WindowCounts.Pusher` (unread/mention),
// `Session.Broadcaster` (topic/modes/created) and the read-cursor fan-out.
// `Broadcaster.to_channel/3`'s own moduledoc calls it "the carrier for
// post-join-handshake events (messages, topic, modes, members)". Leaving it
// would make a paused channel BLIND, not quiet — and the reported use case is
// hopping between ACTIVE channels, which is exactly the signal that would be
// lost. vjt's ruling, 2026-08-22: messages must not be lost.
//
// So the subscription stays and the noise is dropped where it arrives.
//
// #1769 ADDS a second cut without reversing that. The subscription still
// stays — what changes is that a paused channel RE-JOINS the same topic
// carrying `{presence: false}`, and the server then declines to push the
// three pausable kinds at all. The events stop crossing the socket instead of
// being decoded and discarded here, which is the cost #1680 could not reach:
// it saved render and store work, never bytes, parse or wakeups.
//
// The drop below is KEPT rather than replaced, and not out of caution. It is
// what serves an older server (the param is read once at join and silently
// ignored by anything predating protocol 7), and it is what covers the
// microseconds between a re-join landing and the server swapping this
// socket's fastlane. Two cuts, one rule — `PAUSABLE_PRESENCE_KINDS` below is
// pinned to the server's `Message.pausable_presence_kinds/0` by
// `presence_filter_test.exs`, so they cannot disagree about which kinds those
// are.
//
// WHY NOT ALL FIVE PRESENCE KINDS
//
// `SUPPRESSED_PRESENCE_KINDS` (presenceFilter.ts, byte-pinned to the server
// twin) has five members, and two of them have consumers that are
// load-bearing even for a channel nobody is watching:
//
//   * `nick_change` drives the #372/#373 client-side identity migration —
//     renameScrollbackKey / renameReadCursorChannel / renameRailWhois /
//     followQueryNick. Drop it and cic's caches stay keyed to a nick that no
//     longer exists, silently, until something forces a refetch.
//   * `mode` feeds channel-mode state that survives the pause.
//
// And regardless of kind, our OWN presence is never noise: an own PART tears
// the window down (`setParted` + the #200 subscription teardown), so dropping
// it would leak a subscription and strand a dead window.
//
// The three that remain — a PEER joining, parting or quitting — are the 82%.
// Their only consumer is the members map, and that is precisely what the
// on-focus refetch rebuilds.

import type { ScrollbackMessage } from "./api";
import type { ChannelKey } from "./channelKey";
import { createPresenceCooldown } from "./presenceCooldown";

// The paused-channel drop set: a strict SUBSET of the presence kinds, chosen
// by "has no consumer other than the members map". Kept as its own literal
// rather than derived from `SUPPRESSED_PRESENCE_KINDS` because the two answer
// different questions — that one is "is this presence?" (pinned to the server
// twin), this one is "is this presence we can afford to miss?". A new kind
// landing in the server twin must be considered HERE on purpose, not
// inherited silently; `presencePause.test.ts` asserts the subset relation so
// the two cannot drift apart unnoticed.
export const PAUSABLE_PRESENCE_KINDS: ReadonlySet<ScrollbackMessage["kind"]> = new Set([
  "join",
  "part",
  "quit",
]);

export interface PresencePause {
  // Selection moved. Pass the newly focused channel, or null when nothing
  // channel-shaped is selected. Blurs the previously focused key (arming its
  // window) and resumes the new one, firing `onResume` if it had been paused.
  focus(key: ChannelKey | null): void;
  // Is this channel currently swallowing peer presence?
  isPaused(key: ChannelKey): boolean;
  // The dispatch-edge predicate. True only for a peer join/part/quit on a
  // channel that is currently paused.
  shouldDrop(key: ChannelKey, kind: ScrollbackMessage["kind"], isOwnNick: boolean): boolean;
  // Currently paused channels. Diagnostic + test surface.
  paused(): ChannelKey[];
  // Teardown / identity rotation: cancel windows and un-pause everything.
  dispose(): void;
}

// The two edges of a pause, as injected callbacks — the shape
// `presenceCooldown.ts` chose for its own terminal action, for the same
// reason: what "paused" DOES is the contested part, and holding it behind a
// seam keeps changing it a one-line edit at the wiring site.
//
// `onPause` fires when a blurred channel's cooldown expires. #1769 hangs the
// server-side half off it: a re-join carrying `{presence: false}`, so the
// events stop crossing the socket at all instead of being decoded and thrown
// away here.
//
// `onResume` fires when a channel that WAS paused regains focus — the seam
// the members refetch hangs off, because that is the one store the pause let
// go stale. It does not fire for a channel that was merely blurred and came
// back inside its window: nothing was dropped, so nothing needs rebuilding.
//
// An OBJECT rather than two positional callbacks: they have identical types,
// so a swapped pair would type-check and then refetch on pause and mute on
// resume — a bug with no compiler to catch it.
export interface PresencePauseHandlers {
  onPause: (key: ChannelKey) => void;
  onResume: (key: ChannelKey) => void;
}

export function createPresencePause(
  handlers: PresencePauseHandlers,
  cooldownMs: number,
): PresencePause {
  const pausedKeys = new Set<ChannelKey>();

  const cooldown = createPresenceCooldown((key) => {
    pausedKeys.add(key);
    handlers.onPause(key);
  }, cooldownMs);
  let focused: ChannelKey | null = null;

  return {
    focus(key: ChannelKey | null): void {
      if (key === focused) return;
      if (focused !== null) cooldown.blurred(focused);
      focused = key;
      if (key === null) return;
      cooldown.focused(key);
      // `delete` returns whether it was there — so the refetch is ordered
      // exactly when presence was actually missed, never on a plain re-focus.
      if (pausedKeys.delete(key)) handlers.onResume(key);
    },

    isPaused(key: ChannelKey): boolean {
      return pausedKeys.has(key);
    },

    shouldDrop(key: ChannelKey, kind: ScrollbackMessage["kind"], isOwnNick: boolean): boolean {
      if (isOwnNick) return false;
      if (!PAUSABLE_PRESENCE_KINDS.has(kind)) return false;
      return pausedKeys.has(key);
    },

    paused(): ChannelKey[] {
      return [...pausedKeys];
    },

    dispose(): void {
      cooldown.dispose();
      pausedKeys.clear();
      focused = null;
    },
  };
}
