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

  onIdentityChange(() => {
    setActiveAudio(null);
    setPlayerHidden(false);
  });

  return {
    activeAudio,
    playerHidden,
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
      setActiveAudio({ href, label });
      setPlayerHidden(false);
    },
    // The STOP verb (#115), unchanged: clearing the source is what makes the
    // element effect pause and detach it. #1697 only adds the reset, so a
    // dismissed player cannot leave a stale flag for the next source.
    closeAudio(): void {
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

export const { activeAudio, playAudio, closeAudio, playerHidden, hidePlayer, showPlayer } =
  exports_;
