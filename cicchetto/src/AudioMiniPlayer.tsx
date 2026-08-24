import { type Component, createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import {
  activeAudio,
  closeAudio,
  hidePlayer,
  playerHidden,
  rememberResumePoint,
  resumePoint,
} from "./lib/audioPlayer";
import {
  applyMediaSession,
  mediaSessionMetadata,
  setMediaSessionHandlers,
  setMediaSessionPlaybackState,
} from "./lib/mediaSession";
import { nowPlayingLabel } from "./lib/nowPlaying";

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
// Two shapes this must NOT become, both of which break playback:
//   * hiding by unmounting this component from Shell — that destroys the
//     element;
//   * carrying the hidden flag inside `activeAudio` — that re-fires the effect
//     below, which reassigns `.src` and re-buffers a live stream.
//
// The door back is in `RailActions`, not here: a restore handle left in this
// slot would still have to clear the 44px tap floor, so it would give back
// almost none of the vertical space that motivated hiding.
//
// #1701 — what unmounting ACTUALLY does, measured, because the first bullet
// above used to end "(which is why leaving chat for home already stops
// playback)" and that is not what happens. The source is MODULE state
// (`lib/audioPlayer.ts`) and outlives the component, so leaving a scrollback
// window for home / list / mentions / admin destroys the element — and coming
// back RE-MOUNTS it: the `on(activeAudio, …)` effect below runs on its first
// execution, reassigns `.src` and calls `play()`. The semantics are
// kill-and-re-tune, not stop. A station re-buffers (#1700's `mustRefetch` says
// re-tuning IS the correct resume for one), and an UPLOAD restarts from the
// beginning, unasked — that half is a defect in its own right and is not this
// file's to fix. Recorded here so the next reader reasons about the code
// rather than about this comment.
//
// Where "stop" genuinely lives, and neither of the two depends on where this
// component is mounted: `closeAudio` (the ✕ — it clears the source, and the
// effect below pauses and detaches on null), and the `identityScopedStore`
// wrapper around the store, whose `onIdentityChange` nulls the same signal.
// That second one is what keeps a logout or a token rotation from playing the
// previous identity's audio over the new identity's shell.

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

  // #1734 — a position waiting for the element to know its own length.
  // `currentTime` written next to `.src` is dropped by a real browser: the
  // seekable range does not exist until metadata arrives, which is why this
  // is applied from `onLoadedMetadata` below and not two lines after the
  // assignment. Always cleared at the top of the effect, so a source that
  // changes mid-flight cannot land the previous one's position.
  let pendingSeek: number | null = null;

  // Point the element at the active href + autoplay on open; on close,
  // stop + detach the source so a closed player holds no buffered audio.
  createEffect(
    on(activeAudio, (a) => {
      if (audioEl === undefined) return;
      pendingSeek = null;
      if (a === null) {
        audioEl.pause();
        audioEl.removeAttribute("src");
        audioEl.load();
        setCurrent(0);
        setDuration(0);
        return;
      }

      // #1734 — this effect's FIRST execution cannot tell a new source from a
      // re-mount: the source is module state and outlives the component, so
      // leaving a scrollback window for home / list / mentions / admin and
      // coming back re-runs exactly this code. A remembered point is the
      // difference, and there is one only after a destruction.
      //
      // Restoring `duration` FIRST is load-bearing and is why no second
      // predicate was added: `mustRefetch` asks `live()`, which reads the
      // `duration` signal — recreated at a finite 0 on a fresh element. Left
      // at 0 the predicate answers "no re-fetch" for a stream as well, which
      // is both the wrong resume AND, measured, a seek slider drawn across an
      // endless source. Fed the remembered length it answers correctly for
      // both, exactly as it does everywhere else.
      const resume = resumePoint();
      setCurrent(resume?.position ?? 0);
      setDuration(resume?.duration ?? 0);

      audioEl.src = a.href;

      if (resume !== null && !mustRefetch(audioEl)) {
        // A healthy FILE: come back where it was, and preserve the transport
        // rather than pick one. The operator changed window; they did not ask
        // for a stop, and they did not ask for a start either.
        pendingSeek = resume.position;
        if (resume.playing) void audioEl.play().catch(() => {});
        return;
      }

      // Everything else — a first tune, or a stream, whose correct resume IS
      // re-tuning (#1700). Unchanged.
      //
      // Autoplay may be blocked (no user gesture / iOS policy); the user
      // taps play in that case — swallow the rejection, don't surface it.
      void audioEl.play().catch(() => {});
    }),
  );

  // #1734 — the element is about to be destroyed; the transport's position is
  // about to go with it. One write, at the only instant that has the fact.
  onCleanup(() => {
    if (audioEl === undefined || activeAudio() === null) return;
    rememberResumePoint({
      position: audioEl.currentTime,
      duration: audioEl.duration,
      playing: playing(),
    });
  });

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

  // #1700 — can this element continue from where it is, or must the resource
  // be fetched again? Two disjoint reasons, and note that neither of them is
  // "was it interrupted":
  //   * `error` — the media resource is gone. There is nothing to continue.
  //   * live    — there is no POSITION to continue TO. `currentTime` on an
  //               endless source is elapsed-since-tune-in, not a place in a
  //               work, so resuming in place returns to buffered audio and
  //               stays exactly that far behind live from then on. Re-tuning
  //               IS the correct resume for a stream; it is not a sacrifice
  //               made to fix something else.
  // A healthy paused FILE matches neither and keeps resuming at its position,
  // which is the whole point of pausing one.
  const mustRefetch = (el: HTMLAudioElement): boolean => el.error !== null || live();

  // #1702 split these two out of `togglePlay`. A lock screen does not send a
  // toggle — it sends `play` and `pause` as distinct actions, and handing it a
  // toggle would PAUSE on a `play` that arrives while the stream is already on
  // (the OS re-asserts intent freely). So the verbs are the primitive and the
  // toggle is built from them, rather than the toggle being the only door.
  const pauseNow = (): void => {
    if (audioEl === undefined) return;
    audioEl.pause();
  };

  const playNow = (): void => {
    if (audioEl === undefined) return;
    // `play()` re-runs resource selection only from NETWORK_EMPTY, which is not
    // where a dropped stream lands; `load()` runs it unconditionally. The other
    // `load()` in this file DETACHES a source on close — same call, opposite
    // intent, and until now the only one.
    if (mustRefetch(audioEl)) audioEl.load();
    void audioEl.play().catch(() => {});
  };

  const togglePlay = (): void => {
    // #1700 — branch on `playing()`, NOT on `audioEl.paused`. The glyph and the
    // accessible name below read from this signal, and a control must act on
    // the fact it DISPLAYS: after a failed fetch the element is still not
    // `paused` while the transport already shows ▶, so reading the element here
    // pauses at the moment the operator pressed play. One fact, one control.
    if (playing()) pauseNow();
    else playNow();
  };

  // #1702 — tell the OS what is playing. Until this, an iOS lock screen showed
  // "Cicchetto" and nothing else: nothing ever set `navigator.mediaSession`.
  //
  // THREE effects rather than one, because they track three different facts
  // and folding them would re-run all three whenever any one moved — which for
  // the handlers means re-registering them on every track change, and for the
  // metadata means rebuilding a `MediaMetadata` on every play/pause.
  //
  // The projection itself lives in `lib/mediaSession.ts`; what belongs HERE is
  // only what needs the element. That is why the handlers are wired in this
  // file and not in the lib: they must drive the SAME element the in-app bar
  // drives, or the lock screen and the transport end up as two controls over
  // one stream, disagreeing.
  createEffect(() => {
    applyMediaSession(mediaSessionMetadata());
  });

  createEffect(() => {
    // Cleared with the source: a lock screen still holding handlers for a
    // stopped player would send actions to an element with no `src`.
    setMediaSessionHandlers(activeAudio() === null ? null : { play: playNow, pause: pauseNow });
  });

  createEffect(() => {
    // Mirrored from `playing()` — the same signal the glyph reads, for the same
    // reason #1700 gives: the OS must show the state the operator is being
    // shown, not one it inferred from the audio pipeline.
    if (activeAudio() === null) setMediaSessionPlaybackState("none");
    else setMediaSessionPlaybackState(playing() ? "playing" : "paused");
  });

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
        /* #1700 — a failure that is never observed can never be recovered
           from, and an unobserved one here also made the bar LIE: a stream
           that dies without firing `pause` left this signal true, so the
           button kept showing ⏸ over silence and the transport looked like it
           had worked.
           `stalled` and `waiting` are deliberately NOT wired. They are
           recoverable buffering, not a stop, and clearing the state on them
           would flip the button to ▶ over audio that is still coming — the
           same lie in the other direction. `error` is the terminal one, so
           `error` is the one listened to. */
        onError={() => setPlaying(false)}
        onTimeUpdate={() => setCurrent(audioEl?.currentTime ?? 0)}
        onLoadedMetadata={() => {
          setDuration(audioEl?.duration ?? 0);
          // #1734 — the element now has a seekable range, so the position
          // remembered from the last destruction can finally be applied. The
          // browser clamps it to the real length, so a source that turned out
          // shorter lands at its end rather than nowhere.
          if (pendingSeek !== null && audioEl !== undefined) {
            audioEl.currentTime = pendingSeek;
            setCurrent(audioEl.currentTime);
            pendingSeek = null;
          }
        }}
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
          {/* #1698 — what the station is playing, on the surface a phone can
              actually see. The rail carries the same fact, and on mobile the
              rail is `translateX(100%)` off-screen while the station plays —
              the identical argument that put the label above here in #682,
              one field further. Absent for an upload, which has no feed, and
              absent for a station whose feed has gone quiet: the store's
              `nowPlayingLabel` is null on every arm but `playing`, so the
              stale rule reaches this row without this row knowing about it. */}
          <Show when={nowPlayingLabel()}>
            {(track) => (
              <span class="audio-mini-player-track" data-testid="audio-mini-player-track">
                {track()}
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
