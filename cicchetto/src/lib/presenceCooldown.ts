// #1680 — the grace window between "the user looked away" and "the user is
// done with this channel".
//
// A 7-network account ingests ~30 events/s, 82% of them join/part/quit for
// channels nobody is looking at, and the client's main thread is what
// drowns. The lever is to stop taking presence for channels the user has
// stopped visiting. The hazard is doing that on every blur: alt-tabbing
// across ten channels would then become ten releases and ten re-acquisitions
// — a refetch storm, which is #1679's failure mode wearing a new costume,
// and it also throws away state that is about to be needed again.
//
// So a blur does not release anything; it ARMS a window. Coming back inside
// the window disarms it. vjt, 2026-08-22: "a channel the user flicks through
// and comes back to should never have left."
//
// WHAT THIS MODULE DELIBERATELY DOES NOT KNOW
//
// It does not know what "releasing" a channel means, and it does not know
// what "focus" is. It owns the WINDOW and nothing else: callers report
// focused/blurred, and the terminal action arrives as `release`. That is not
// decoration — the terminal action is the one part of #1680 that is still
// contested (leaving the per-channel Phoenix topic also stops MESSAGES,
// because `Grappa.Session.Persistor` broadcasts them on that same topic), so
// it is held behind an injected callback where changing it costs one line at
// the wiring site instead of a rewrite here.
//
// Mirrors `visibilityHeartbeat.ts`: exported constant + factory over an
// injected timer effect, so vitest fake timers drive it deterministically.

import type { ChannelKey } from "./channelKey";

// The cooldown, and the ONE place it is named.
//
// 🔴 CHOSEN, NOT MEASURED (vjt, 2026-08-22). No on-device timing exists for
// how long a user dwells away before coming back, so this is a starting
// value picked to be comfortably longer than a tab-switch and comfortably
// shorter than a coffee break — not a number any measurement produced.
//
// Honest consequence of a window this long: the pause only bites once the
// user actually STOPS visiting a channel. Someone touring ten channels
// inside two minutes holds ten subscriptions at once — still far below the
// 43 seeded channels all held today, but the relief is "the channels you
// left alone", not "one at a time". That is the accepted trade against
// re-seeding on every flick, and it is worth re-measuring the event rate
// with the cooldown live rather than assuming the win.
export const PRESENCE_COOLDOWN_MS = 120_000;

export interface PresenceCooldown {
  // The user is looking at this channel: disarm any pending window. Safe to
  // call for a channel with no window — that is the common case.
  focused(key: ChannelKey): void;
  // The user looked away: arm (or re-arm) this channel's window. Never
  // releases synchronously, and never stacks — a second blur replaces the
  // first window rather than queueing a second release.
  blurred(key: ChannelKey): void;
  // Channels currently inside their window. Diagnostic + test surface; the
  // production path does not branch on it.
  pending(): ChannelKey[];
  // Cancel every pending window (teardown / identity rotation). No release
  // fires after this.
  dispose(): void;
}

// `cooldownMs` is REQUIRED rather than defaulted to PRESENCE_COOLDOWN_MS.
// A default would let a second call site acquire the window without naming
// it, and "one named place" is the property the brief actually asked for —
// so the constant appears at the wiring site, in the open.
export function createPresenceCooldown(
  release: (key: ChannelKey) => void,
  cooldownMs: number,
): PresenceCooldown {
  const windows = new Map<ChannelKey, ReturnType<typeof setTimeout>>();

  const disarm = (key: ChannelKey): void => {
    const id = windows.get(key);
    if (id !== undefined) {
      clearTimeout(id);
      windows.delete(key);
    }
  };

  return {
    focused(key: ChannelKey): void {
      disarm(key);
    },

    blurred(key: ChannelKey): void {
      // Re-arm rather than stack: the window measures time since the LAST
      // time the user looked away, so a re-blur restarts it.
      disarm(key);
      windows.set(
        key,
        setTimeout(() => {
          // Drop the entry BEFORE releasing, so `release` observing
          // `pending()` (or re-arming the same key) sees a settled map.
          windows.delete(key);
          release(key);
        }, cooldownMs),
      );
    },

    pending(): ChannelKey[] {
      return [...windows.keys()];
    },

    dispose(): void {
      for (const id of windows.values()) clearTimeout(id);
      windows.clear();
    },
  };
}
