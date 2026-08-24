// Docked audio mini-player state — audio uploads (GH #115).
//
// Module-scope signal store, same pattern as `mediaViewer.ts`: the open
// trigger lives deep inside ScrollbackPane's module-scope renderRun, far
// from any component that could thread a callback down — a lib store is
// the established cic shape for that. `AudioMiniPlayer.tsx` (mounted at
// Shell root) renders the state; `lib/mediaLink.ts` decides which links
// route here (kind: "audio") vs to `openMediaViewer` (image/video).
//
// Distinct from `mediaViewer.ts` by design (CLAUDE.md "IRC stays text
// only"): audio must NOT open the image/video modal. The mini-player is
// non-modal — scrollback stays scrollable + readable while it plays —
// and persistent: switching the active channel doesn't kill playback,
// clicking a new audio link swaps the source. ONE player instance, not N.
//
// identityScopedStore (same reason as mediaViewer.ts): token rotation /
// logout must stop playback — otherwise the previous identity's audio
// keeps playing on top of the new identity's shell.

import { createSignal } from "solid-js";
import { identityScopedStore } from "./identityScopedStore";

export type AudioPlayerState = {
  href: string;
  /** Human name for the source, or null when it has none (an upload is
      identified by its link, not by a title). See `playAudio`. */
  label: string | null;
};

/** Where the transport was when the element went away (#1734). */
export type AudioResumePoint = {
  /** Seconds into the source. */
  position: number;
  /** The element's last stated length — `Infinity` / `NaN` for an endless
      source. Carried for a reason that is not display: it is what puts
      `AudioMiniPlayer`'s `mustRefetch` back in a position to answer on a
      fresh element, whose own `duration` signal starts at a finite 0 and so
      makes a stream look like a file. See that file's #1734 comment. */
  duration: number;
  /** Whether it was playing. A re-mount nobody asked for must not start
      audio the operator had paused — cic does not originate state. */
  playing: boolean;
};

const exports_ = identityScopedStore((onIdentityChange) => {
  const [activeAudio, setActiveAudio] = createSignal<AudioPlayerState | null>(null);
  // #1697 — HIDING IS NOT STOPPING, and this is the signal that separates them.
  //
  // Three facts live around this player: there IS a source (`activeAudio`), it
  // IS playing (the <audio> element itself, mounted unconditionally by
  // `AudioMiniPlayer` OUTSIDE the <Show> that gates the chrome), and the
  // transport is ON SCREEN. The third had no home, so dismissing the bar could
  // only be spelled `closeAudio` — which clears the source and therefore stops.
  //
  // WHY A SIBLING SIGNAL AND NOT A FIELD OF `AudioPlayerState`. #682 put
  // `label` in there because it must swap atomically WITH the source, and the
  // instinct is to follow that. It is wrong here, measurably:
  // `AudioMiniPlayer` drives the element from `createEffect(on(activeAudio,…))`
  // and that effect's body assigns `audioEl.src`. Assigning `.src` re-invokes
  // the media load algorithm even when the URL has not changed, so a hidden
  // flag riding inside the state object would hand the effect a new reference
  // and RESTART the stream on every hide — the exact thing this issue forbids.
  // `label` describes the SOURCE; this describes the CHROME. Different axes,
  // different signals.
  const [playerHidden, setPlayerHidden] = createSignal(false);

  // #1734 — where the transport was when the element was last destroyed.
  //
  // A SIBLING SIGNAL, for the reason #1697 spells out one comment up and
  // measured: `AudioMiniPlayer` drives the element from
  // `createEffect(on(activeAudio, …))`, whose body assigns `audioEl.src`, and
  // assigning `.src` re-invokes the media load algorithm even when the URL has
  // not changed. A position riding INSIDE `AudioPlayerState` would hand that
  // effect a new object on every write and restart the source — inside the fix
  // whose entire purpose is to stop unrequested restarts. `position` describes
  // the TRANSPORT; `href`/`label` describe the SOURCE. Different axes.
  //
  // It carries no href of its own because it does not need one: every writer
  // of `activeAudio` below clears it, so a point that exists belongs to the
  // source that is active. A FOURTH writer of `activeAudio` must clear it too,
  // or a new source inherits the old one's position — pinned by
  // "a NEW source does not inherit the previous one's position".
  const [resumePoint, setResumePoint] = createSignal<AudioResumePoint | null>(null);

  onIdentityChange(() => {
    setActiveAudio(null);
    setPlayerHidden(false);
    setResumePoint(null);
  });

  return {
    activeAudio,
    playerHidden,
    resumePoint,
    // #1734 — called from the component's `onCleanup`, i.e. exactly once per
    // destruction, at the instant the fact is about to be lost. Deliberately
    // NOT written on every `timeupdate`: that would be four writes a second to
    // module state to keep a value only this one moment reads.
    rememberResumePoint(point: AudioResumePoint): void {
      setResumePoint(point);
    },
    // Start (or swap to) the audio at `href`. One instance: a second
    // click replaces the source rather than stacking a new player.
    //
    // #682 — `label` rides WITH the href rather than sitting in a sibling
    // signal, because the two must swap ATOMICALLY: a separate signal lets a
    // station's name outlive the source it named for one render, captioning
    // the next upload with the station that preceded it. It is REQUIRED, not
    // defaulted (CLAUDE.md: no silent-degradation defaults) — a caller with
    // nothing to say passes `null` and says so.
    //
    // Why a label exists at all: on mobile the right rail is a drawer slid
    // off-screen (`transform: translateX(100%)`), so while a radio station
    // plays, this docked bar is the only surface naming it. Without the label
    // the phone cannot answer "what am I listening to".
    //
    // #1697 — a new source ALWAYS shows its transport. Leaving a hidden bar
    // hidden would let the next upload play with no controls anywhere on
    // screen, which is a worse version of the bug this fixes.
    playAudio(href: string, label: string | null): void {
      // #1734 — a remembered position belongs to the source it was taken
      // from, and clearing it here is what lets the point carry no href.
      //
      // 🔴 BEFORE `setActiveAudio`, not after, and this order is load-bearing
      // — MEASURED. Solid runs the `on(activeAudio, …)` effect SYNCHRONOUSLY
      // inside the setter, so a clear written on the next line arrives after
      // the effect has already read the OLD point: it armed the previous
      // source's position and the new source landed at 0:42.
      // `[D] after playAudio: currentTime=0` then `after metadata: 42`.
      setResumePoint(null);
      setActiveAudio({ href, label });
      setPlayerHidden(false);
    },
    // The STOP verb (#115), unchanged: clearing the source is what makes the
    // element effect pause and detach it. #1697 only adds the reset, so a
    // dismissed player cannot leave a stale flag for the next source.
    closeAudio(): void {
      // #1734 — ✕ is the STOP verb: it must not leave a position behind for
      // whatever gets tuned next. Cleared first, for the same synchronous
      // -effect reason spelled out in `playAudio` — the null arm does not read
      // the point today, and ordering it defensively costs nothing while
      // relying on that fact costs the next reader a measurement.
      setResumePoint(null);
      setActiveAudio(null);
      setPlayerHidden(false);
    },
    // #1697 — take the transport off screen. Deliberately says nothing about
    // the source: the element keeps its src and keeps playing, and that is the
    // whole point. `RailActions` renders the door back while this is true.
    hidePlayer(): void {
      setPlayerHidden(true);
    },
    showPlayer(): void {
      setPlayerHidden(false);
    },
  };
});

export const {
  activeAudio,
  playAudio,
  closeAudio,
  playerHidden,
  hidePlayer,
  showPlayer,
  resumePoint,
  rememberResumePoint,
} = exports_;
