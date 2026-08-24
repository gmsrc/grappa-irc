import { activeAudio, audioFailureLabel, playbackFailure } from "./audioPlayer";
import { nowPlaying } from "./nowPlaying";
import { tunedStation } from "./radio";

// #1702 — what the OS is told about what we are playing.
//
// On an iOS lock screen the player showed "Cicchetto" and nothing else: the OS
// knew an app was making noise and had no way to learn more, because nothing
// ever set `navigator.mediaSession`. This module is the projection that tells
// it, and `AudioMiniPlayer` is what drives the projection at the element.
//
// WHY A PROJECTION AND NOT A STORE. Everything on a lock screen is already
// written down somewhere in cic: the source in `activeAudio()`, the station
// derived from it by `tunedStation()`, the track derived from THAT by
// `nowPlaying()`. A signal holding "current lock-screen metadata" would be a
// fourth copy needing housekeeping, and it would drift the first time a source
// swapped without anyone remembering to update it. Same reasoning `radio.ts`
// gives for not storing the tuned station — derive, don't duplicate.
//
// THE FIELD MAPPING IS THE PLATFORM'S, NOT THE ISSUE'S. #1702 as filed asked
// for `title` = the station name with the track fed into `artist`/`album`.
// Taken literally that puts a TRACK TITLE in the `artist` slot, and since
// `title` is the primary line on a lock screen it would leave the station
// shouting and the track buried — half of the very complaint the issue opens
// with ("no station, no track"). So: `title` is the TRACK, `artist` is its
// artist, `album` is the STATION. That is not a new direction invented here,
// it is the spelling this codebase already uses in `nowPlayingLine`:
// `<artist> — <title> [<station>]`, which treats the station as context and
// the track as the subject. Approved on the issue before this was written.
//
// WHAT IT SAYS WHEN IT DOES NOT KNOW. With no track yet, `title` falls back to
// the station name so the lock screen still names something real. It never
// invents: an upload has no station and no feed, so it is named by its own
// slug, which is the only honest thing we hold about it.

/** One lock-screen image. `type` is ABSENT rather than guessed when the URL
    carries an extension we have no mime for — see `artworkFor`. */
export type MediaSessionArtwork = {
  readonly src: string;
  readonly type?: string;
};

/** Our projection of what is playing, in the shape `MediaMetadata` takes. */
export type MediaSessionMetadata = {
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly artwork: readonly MediaSessionArtwork[];
};

/** Extension → mime, for the logo URLs the curated table carries.
 *
 * #1696 is why this READS the URL instead of assuming one extension: the table
 * holds 10 `.jpg` and 4 `.png`, and the `<id>120.png` shape that used to be
 * assumed only LOOKED like a convention. Reading the extension off the string
 * is reading a value we were given; inferring it would be repeating the exact
 * mistake that issue existed to fix. */
const LOGO_MIME: Readonly<Record<string, string>> = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** Describe a logo for the OS.
 *
 * `sizes` is deliberately NOT emitted. Every row today sits under `/logos/120/`
 * and the temptation is to read 120 out of the path — but that is inferring a
 * dimension from a directory name, which is the guess #1696 punished, not the
 * verbatim read that fixed it. The dimensions are not in `RadioStation`, so we
 * do not claim them; `MediaImage` requires only `src`. */
function artworkFor(logoUrl: string): MediaSessionArtwork {
  const ext = logoUrl.split(".").pop()?.toLowerCase();
  const type = ext === undefined ? undefined : LOGO_MIME[ext];
  return type === undefined ? { src: logoUrl } : { src: logoUrl, type };
}

/** The last path segment of an upload's URL — the only name we hold for it.
 *
 * An upload is identified by its link, not by a title (`AudioPlayerState.label`
 * is null for one), so the honest lock-screen caption is the slug rather than
 * an invented "Audio" or the app's own name, which is what the OS already
 * falls back to and what filed this issue. */
function uploadTitle(href: string): string {
  try {
    const segment = new URL(href).pathname
      .split("/")
      .filter((s) => s !== "")
      .pop();
    // `decodeURIComponent` is inside the same `try` on purpose: a malformed
    // escape throws, and the whole href is a better caption than a crash.
    return segment === undefined ? href : decodeURIComponent(segment);
  } catch {
    return href;
  }
}

/**
 * What the platform should be told, or `null` when nothing is playing.
 *
 * Reactive: it reads `activeAudio()`, `tunedStation()` and `nowPlaying()`, so
 * it re-derives on every transition that matters — tuning, swapping station, an
 * upload seizing the player, the transport's ✕, identity rotation — without
 * subscribing to any of them itself.
 */
export function mediaSessionMetadata(): MediaSessionMetadata | null {
  const audio = activeAudio();
  if (audio === null) return null;

  // #1744 — the failure OUTRANKS the track, on both arms below. The OS is the
  // fourth surface and on a phone it is often the only one awake: the screen
  // is locked, the docked bar is behind it, the rail is a drawer off-screen.
  // A lock screen naming a track over a stream that never decoded is the
  // silence this issue is about, one layer out — and it is the same rule the
  // `stale` arm obeys further down: cic must not assert to the OS something it
  // has stopped telling the operator.
  const failure = playbackFailure();

  const station = tunedStation();
  if (station === null) {
    // An upload, or any source outside the curated table. No station, no feed,
    // no logo to borrow — an empty `artwork` lets the OS keep the app icon
    // rather than be handed some other station's art.
    return {
      title: audio.label ?? uploadTitle(audio.href),
      artist: failure === null ? "" : audioFailureLabel(failure),
      album: "",
      artwork: [],
    };
  }

  // #1704 — a station that publishes no artwork hands the OS NOTHING, which is
  // the same answer an upload gets in the arm above and for the identical
  // reason: an empty `artwork` lets the platform keep the app icon, which is a
  // real image at every size it asks for. Our own placeholder is deliberately
  // NOT sent — it is an SVG built for one 120px slot in the rail, `MediaImage`
  // support for SVG is not something this codebase has measured on any
  // platform, and a lock screen that refuses it would fall back to the app icon
  // anyway. Sending nothing gets there without the claim.
  const artwork = station.logoUrl === null ? [] : [artworkFor(station.logoUrl)];

  // The ARTIST slot, and it is not a compromise: it is the second line, and on
  // a failure there is no track and therefore no artist to displace. `title`
  // keeps naming the SOURCE, which is what completes the sentence — "Groove
  // Salad / connection lost". Putting the reason in `title` would cost the
  // operator the name of the thing that failed.
  //
  // `playbackState` is deliberately NOT moved to "none" alongside this. The
  // platform's three states are `none | paused | playing`, and a UA is free to
  // drop the whole now-playing card on "none" — which would take this sentence
  // off the lock screen along with the transport button that `playNow` already
  // retries through. Read off the Media Session spec, not measured on a device.
  if (failure !== null) {
    return { title: station.title, artist: audioFailureLabel(failure), album: "", artwork };
  }

  const state = nowPlaying();

  // Matching `playing` alone is the STALE RULE, and it is deliberate: reading
  // `state.track` off whatever arm happens to carry one would keep the lock
  // screen naming a track after `nowPlayingLabel()` has already stopped naming
  // it on screen, i.e. cic would assert to the OS something it has stopped
  // telling the operator. Same predicate, same answer, both surfaces.
  if (state.status === "playing") {
    return {
      title: state.track.title,
      artist: state.track.artist ?? "",
      album: station.title,
      artwork,
    };
  }

  return { title: station.title, artist: "", album: "", artwork };
}

/** The platform's session, or `null` where there is none.
 *
 * Every entry point below feature-detects through here. A browser without the
 * API must keep playing audio exactly as it did before #1702 — the metadata is
 * an enhancement, and failing to set it is never a reason to break playback. */
function session(): MediaSession | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession ?? null;
}

/** Hand `metadata` to the OS, or clear it when nothing is playing. */
export function applyMediaSession(metadata: MediaSessionMetadata | null): void {
  const s = session();
  if (s === null) return;

  if (metadata === null) {
    s.metadata = null;
    return;
  }
  // `MediaMetadata` can be absent even where `mediaSession` is present; the
  // constructor is a separate global.
  if (typeof MediaMetadata !== "function") return;

  s.metadata = new MediaMetadata({
    title: metadata.title,
    artist: metadata.artist,
    album: metadata.album,
    // Copied into a mutable array of plain objects: the init dict is consumed
    // by the platform, and our own shape is readonly.
    artwork: metadata.artwork.map((a) =>
      a.type === undefined ? { src: a.src } : { src: a.src, type: a.type },
    ),
  });
}

/** Mirror the element's own state, so the lock-screen glyph is what is true
    rather than what the OS inferred from the audio pipeline. */
export function setMediaSessionPlaybackState(state: MediaSessionPlaybackState): void {
  const s = session();
  if (s === null) return;
  s.playbackState = state;
}

/**
 * Point the lock-screen transport at the same element the in-app bar drives.
 *
 * `null` unregisters both. Without this the OS guesses — and its guess acts on
 * the audio pipeline directly, which is how a lock-screen pause can leave cic's
 * own glyph claiming the stream is still on.
 *
 * No `try` around `setActionHandler`: `play` and `pause` are supported by every
 * implementation that ships `mediaSession` at all, and a catch here would be a
 * silent swallow at a boundary — it would hide the next action we add and get
 * wrong, which is the failure mode CLAUDE.md names.
 */
export function setMediaSessionHandlers(
  handlers: { readonly play: () => void; readonly pause: () => void } | null,
): void {
  const s = session();
  if (s === null || typeof s.setActionHandler !== "function") return;

  s.setActionHandler("play", handlers === null ? null : handlers.play);
  s.setActionHandler("pause", handlers === null ? null : handlers.pause);
}
