import { type Component, createEffect, createSignal, on, Show } from "solid-js";
import { activeAudio, closeAudio, hidePlayer, playerHidden } from "./lib/audioPlayer";

// Docked audio mini-player (GH #115) — a slim transport bar pinned above
// the compose box. Non-modal: scrollback stays scrollable + readable
// while audio plays (CLAUDE.md "IRC stays text only" — audio routes here
// instead of MediaViewerModal). Persistent: switching the active channel
// doesn't kill playback; a new audio link swaps the source on the single
// <audio> element. The store (lib/audioPlayer.ts) holds the active href;
// this component owns the element + transport UI.
//
// The <audio> element is mounted UNCONDITIONALLY (it has no `controls`,
// so it renders nothing visible) and only the chrome is gated by <Show>.
// This keeps the `audioEl` ref assigned before the activeAudio effect
// runs — wrapping the element itself in <Show> would race ref-assignment
// against the effect on the open transition.
//
// #682 — LIVE mode. This bar was written for a FILE, and an internet-radio
// station is not one: an Icecast stream has no end, so a position slider and
// a "cur / dur" read are both meaningless against it. Live mode is DERIVED
// from the element's own `duration` (see `live` below) rather than flagged by
// the caller — so it is correct for ANY endless source, not just the radio
// stations that motivated it, and it cannot drift from the element's truth.
// It is the general rule, not the incident.
//
// #1697 — HIDING. The bar was permanent once a source was tuned: the only way
// off the screen was the ✕, which STOPS. Hiding is now a second control and a
// second signal (`playerHidden`), and the mechanism costs nothing because the
// element is ALREADY mounted outside the <Show> below — the unconditional mount
// documented just above, put there for the ref-assignment race, is exactly what
// makes "hide while it keeps playing" free. Narrowing the <Show> predicate
// cannot reach the element.
//
// Two shapes this must NOT become, both of which stop playback:
//   * hiding by unmounting this component from Shell — that destroys the
//     element (which is why leaving chat for home already stops playback);
//   * carrying the hidden flag inside `activeAudio` — that re-fires the effect
//     below, which reassigns `.src` and re-buffers a live stream.
// The door back is in `RailActions`, not here: a restore handle left in this
// slot would still have to clear the 44px tap floor, so it would give back
// almost none of the vertical space that motivated hiding.

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

const AudioMiniPlayer: Component = () => {
  let audioEl: HTMLAudioElement | undefined;
  const [playing, setPlaying] = createSignal(false);
  const [current, setCurrent] = createSignal(0);
  const [duration, setDuration] = createSignal(0);

  // Point the element at the active href + autoplay on open; on close,
  // stop + detach the source so a closed player holds no buffered audio.
  createEffect(
    on(activeAudio, (a) => {
      if (audioEl === undefined) return;
      if (a === null) {
        audioEl.pause();
        audioEl.removeAttribute("src");
        audioEl.load();
        setCurrent(0);
        setDuration(0);
        return;
      }
      audioEl.src = a.href;
      setCurrent(0);
      setDuration(0);
      // Autoplay may be blocked (no user gesture / iOS policy); the user
      // taps play in that case — swallow the rejection, don't surface it.
      void audioEl.play().catch(() => {});
    }),
  );

  // Endless source? `duration` starts at 0 — a FINITE number, so a source
  // whose metadata has not arrived yet keeps today's file chrome and does not
  // flash a "live" badge at every upload. Only `onLoadedMetadata` writes it
  // again, and at that point the element is stating what it knows:
  //   * a file    → a finite length  → scrubbable
  //   * a stream  → Infinity         → not scrubbable
  //   * unknown   → NaN              → not scrubbable either, and the reason
  //                                    is the same one, so the predicate is
  //                                    "not a finite number" rather than
  //                                    "=== Infinity".
  const live = (): boolean => !Number.isFinite(duration());

  const togglePlay = (): void => {
    if (audioEl === undefined) return;
    if (audioEl.paused) void audioEl.play().catch(() => {});
    else audioEl.pause();
  };

  const onSeek = (e: { currentTarget: HTMLInputElement }): void => {
    if (audioEl === undefined) return;
    audioEl.currentTime = Number(e.currentTarget.value);
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useMediaCaption: plays arbitrary user-uploaded
          audio (voice / audio shares, GH #115) — no transcript or caption data
          exists on the wire (the player gets a slug-only href), so a <track>
          would be a hollow no-op element. Captions are N/A by construction. */}
      <audio
        ref={audioEl}
        data-testid="audio-mini-player-el"
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() => setCurrent(audioEl?.currentTime ?? 0)}
        onLoadedMetadata={() => setDuration(audioEl?.duration ?? 0)}
      />
      <Show when={activeAudio() !== null && !playerHidden()}>
        <div class="audio-mini-player" data-testid="audio-mini-player">
          <button
            type="button"
            class="audio-mini-player-toggle"
            data-testid="audio-mini-player-toggle"
            onClick={togglePlay}
            aria-label={playing() ? "pause" : "play"}
          >
            {playing() ? "⏸" : "▶"}
          </button>
          {/* #682 — the source's name, when it has one. An upload passes
              null and this renders nothing; a radio station passes its title,
              which on mobile is the ONLY place naming it (the rail that holds
              the station chrome is a drawer slid off-screen while playing). */}
          <Show when={activeAudio()?.label}>
            {(label) => (
              <span class="audio-mini-player-label" data-testid="audio-mini-player-label">
                {label()}
              </span>
            )}
          </Show>
          <Show
            when={!live()}
            fallback={
              <>
                <span class="audio-mini-player-live" data-testid="audio-mini-player-live">
                  live
                </span>
                {/* Elapsed since tune-in, NOT a position: there is no total
                    to divide it by, so it is shown alone rather than as one
                    half of a "cur / dur" pair with a hollow denominator. */}
                <span class="audio-mini-player-time" data-testid="audio-mini-player-time">
                  {formatTime(current())}
                </span>
              </>
            }
          >
            <input
              type="range"
              class="audio-mini-player-seek"
              data-testid="audio-mini-player-seek"
              min="0"
              max={duration() || 0}
              step="any"
              value={current()}
              onInput={onSeek}
              aria-label="seek"
            />
            <span class="audio-mini-player-time" data-testid="audio-mini-player-time">
              {formatTime(current())} / {formatTime(duration())}
            </span>
            {/* Same-origin download: the `download` attribute forces a save
                (overriding the server's `inline` Content-Disposition) and
                inherits the server-sent filename — cic has no filename on
                the wire (slug only), so no `download` value is set.
                #682 — gated OFF for a live source, for two independent
                reasons either of which is sufficient: the resource has no
                end, so the save never completes; and `download` is ignored
                outright on a cross-origin href, so the anchor would navigate
                the operator out of the app instead of saving anything. */}
            <a
              class="audio-mini-player-download"
              data-testid="audio-mini-player-download"
              href={activeAudio()?.href}
              download=""
              aria-label="download"
            >
              ⬇
            </a>
          </Show>
          {/* #1697 — HIDE, beside the ✕ and never merged with it. The ✕ is the
              STOP verb, and on a phone it is the only reachable one while the
              rail that holds the station chrome is slid off-screen; collapsing
              the two would cost the operator the ability to stop. The glyph is
              a chevron down (the surface leaves downward, past the compose
              box), and the accessible name says what survives the gesture. */}
          <button
            type="button"
            class="audio-mini-player-hide"
            data-testid="audio-mini-player-hide"
            onClick={hidePlayer}
            aria-label="hide player, keep playing"
          >
            ⌄
          </button>
          <button
            type="button"
            class="audio-mini-player-close"
            data-testid="audio-mini-player-close"
            onClick={closeAudio}
            aria-label="close"
          >
            ✕
          </button>
        </div>
      </Show>
    </>
  );
};

export default AudioMiniPlayer;
