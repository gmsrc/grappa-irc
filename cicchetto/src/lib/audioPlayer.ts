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

  onIdentityChange(() => setActiveAudio(null));

  return {
    activeAudio,
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
    playAudio(href: string, label: string | null): void {
      setActiveAudio({ href, label });
    },
    closeAudio(): void {
      setActiveAudio(null);
    },
  };
});

export const { activeAudio, playAudio, closeAudio } = exports_;
