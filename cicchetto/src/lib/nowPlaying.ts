import { createEffect, createSignal, on } from "solid-js";
import { moduleRoot } from "./moduleRoot";
import { tunedStation } from "./radio";

// #1698 — what the tuned station is playing right now.
//
// WHERE THE FACT COMES FROM, AND WHAT WAS RULED OUT. Measured 2026-08-24:
//
//   * ICY in-band metadata is NOT an option, twice over. Requesting the stream
//     with `Icy-MetaData: 1` returns `icy-name` / `icy-genre` / `icy-br` and NO
//     `icy-metaint`, so there is no in-band title track to read at all — and
//     even where there were, a browser `<audio>` element does not surface ICY
//     to the page.
//   * `channels.json` DOES carry a now-playing value (`lastPlaying`), and it is
//     the wrong one: it is a single joined STRING ("Charlie North - Never
//     (Means Forever)"), so reading artist and title out of it means splitting
//     on " - " and getting it wrong the first time a title contains a hyphen.
//     It also costs 52,767 bytes to learn about 46 channels when we want one —
//     19× the 2,771 the per-channel feed costs.
//   * `…/songs/<id>.json` is the workable source: `songs[0]` is the current
//     track, newest first, already SPLIT into `title` / `artist` / `album` /
//     `date`.
//
// CADENCE, AND WHO PAYS FOR IT. This polls a third party's host, once per
// listening tab, and that is an operational choice rather than a detail:
//
//   * 60s. The shortest gap between consecutive tracks measured across all 14
//     stations (223 gaps) was 105s, so a 60s read cannot miss a track outright;
//     the median gap is 259s, so the worst-case staleness is under a quarter of
//     a typical track. Tighter buys accuracy nobody can perceive; looser starts
//     missing short tracks.
//   * The bill is 2.7 KB/min per LISTENING tab — against the 128 kbps stream
//     the same tab is already pulling from the same provider, which is
//     960 KB/min. The metadata is 0.28% of the audio. That ratio is the whole
//     argument: we are already SomaFM's listener, and this is a rounding error
//     on top of what listening costs them.
//   * It is keyed on `tunedStation()`, so an idle player, an audio upload that
//     took the element over, a logout and the transport's ✕ each cost exactly
//     zero. There is no separate "is the radio on" flag to forget to clear —
//     that is the whole reason `radio.ts` derives rather than stores.
//   * NOT keyed on pause, and not on tab visibility, deliberately. `paused`
//     lives inside `AudioMiniPlayer`'s element and lifting it into a store to
//     save 2.7 KB/min would be exactly the parallel structure that drifts. A
//     backgrounded tab is still playing audio, so the ratio above is unchanged.
//   * SERVER-SIDE polling was considered and rejected: it would dedupe the read
//     across users, and it would buy that with a supervised process, a wire
//     event, a protocol bump and a bouncer that depends on somafm being up —
//     for a station that is a purely client-side concept. The mechanism would
//     be heavier than the problem.
//
// FIVE STATES, NOT A TRACK-OR-NULL. Each one has a distinct answer for `/np`,
// which WRITES INTO A CHANNEL, and a distinct display; collapsing them would
// force the command to reconstruct the difference from context it does not
// have. `assertNever` at the consumers makes a sixth compile-loud.
//
// `stale` is the state that exists because of what `/np` is: publishing a
// ten-minute-old track into a channel is worse than a local error. It is
// declared from the age of our last SUCCESSFUL READ, never from the track's own
// `date` — a Drone Zone piece measured 86 minutes long is not stale, it is
// long. And it blanks the DISPLAY too, on purpose: one predicate for both
// doors, so `/np`'s refusal is not a special case bolted onto a surface that
// keeps lying.
//
// The whole module has no reset of its own. It derives from `tunedStation()`,
// which derives from the identity-scoped `audioPlayer` store, so a rotation
// stops the poll by construction — the same reason `radio.ts` gives for owning
// no tuned-station signal.

/** How often the tuned station's feed is re-read. See the cadence note above:
    the number is measured against the observed track-gap distribution, not
    picked. */
export const NOW_PLAYING_POLL_MS = 60_000;

/** How old the last SUCCESSFUL read may get before the track stops being
    something we will show or publish. Three poll intervals: one missed read is
    a blip on a median 259s track, three means we have been blind across the
    p25 gap (193s) and the track we hold is likelier wrong than right.
    Expressed as a multiple so a cadence change carries it along. */
export const NOW_PLAYING_STALE_MS = NOW_PLAYING_POLL_MS * 3;

/** The track on air. `album` is in the feed and deliberately NOT here: nothing
    renders it, and a field no door reads is a field that rots unnoticed. */
export type NowPlayingTrack = {
  /** Absent when the feed gave a blank one — the line then names the title
      alone rather than dangling a dash. */
  readonly artist: string | null;
  readonly title: string;
};

/** What the store can honestly say. Named for what was OBSERVED, per the
    log-honesty rule: `unanswered` is true whether the feed has been silent for
    200ms or for an hour, and does not promise a "yet". */
export type NowPlaying =
  | { readonly status: "idle" }
  | { readonly status: "unsupported" }
  | { readonly status: "unanswered" }
  | { readonly status: "stale" }
  | { readonly status: "playing"; readonly track: NowPlayingTrack };

/** The shape SomaFM gives us. Everything optional: this is a third party's
    document and a missing field must degrade to "no track", never to a throw —
    the poll's error handling exists to keep the previous track on screen
    through a bad answer, and it cannot do that if parsing takes it out. */
type SongsBody = { readonly songs?: unknown };

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * The newest track in a `…/songs/<id>.json` body, or `null` when the document
 * carries none we would show.
 *
 * A blank TITLE is rejected here rather than downstream, and that is the
 * boundary doing its job: `/np` renders the track into a channel, and a blank
 * title is exactly the empty sentence that must never reach the wire. A blank
 * ARTIST is kept — it shortens the line instead of voiding it.
 */
export function parseSongsFeed(body: unknown): NowPlayingTrack | null {
  if (typeof body !== "object" || body === null) return null;
  const songs = (body as SongsBody).songs;
  if (!Array.isArray(songs)) return null;
  const first: unknown = songs[0];
  if (typeof first !== "object" || first === null) return null;
  const row = first as Record<string, unknown>;
  const title = str(row.title);
  if (title === "") return null;
  const artist = str(row.artist);
  return { artist: artist === "" ? null : artist, title };
}

/**
 * The CTCP ACTION body `/np` sends: `is now playing: <artist> — <title>
 * [<station>]`.
 *
 * The STATION is in the line by decision, not by inheritance from the issue's
 * example. It is the only part of the sentence a reader can act on — it turns
 * a boast into something someone else can tune to — and it disambiguates a
 * track title that means nothing on its own.
 *
 * Lives here rather than in the command handler so both doors spell a track
 * the same way, and so a test of the wire text calls the production formatter
 * instead of re-typing it.
 */
export function nowPlayingLine(track: NowPlayingTrack, station: string): string {
  const what = track.artist === null ? track.title : `${track.artist} — ${track.title}`;
  return `is now playing: ${what} [${station}]`;
}

/** What a read of the feed left behind. `at` is stamped at SUCCESS, so
    staleness is measured from when we last knew something — not from the
    track's own start time, which says how long a piece is, not how blind we
    are. */
type LastRead = { readonly track: NowPlayingTrack; readonly at: number };

// `moduleRoot`, not `identityScopedStore`, and the difference is the point:
// this store registers NO identity reset because it has nothing of its own to
// reset. Everything it holds is downstream of `tunedStation()`, which a
// rotation already clears — declaring a reset here would be a second mechanism
// enforcing what the derivation guarantees, and the two would drift.
const exports_ = moduleRoot(() => {
  const [read, setRead] = createSignal<LastRead | null>(null);
  // Separated from `read` rather than folded into it: the two answer different
  // questions ("what did we last learn" vs "is it still worth showing"), and a
  // single nullable would make a recovered read indistinguishable from a first
  // one.
  const [staleFlag, setStaleFlag] = createSignal(false);

  let timer: ReturnType<typeof setInterval> | null = null;

  const stopPolling = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const poll = async (url: string): Promise<void> => {
    let track: NowPlayingTrack | null = null;
    try {
      const res = await fetch(url, {
        // Explicit, though it is also the cross-origin default: this is a
        // third party's host and must never be handed a grappa cookie. Stated
        // so a later edit to this options object cannot silently turn it on.
        credentials: "omit",
      });
      if (res.ok) track = parseSongsFeed(await res.json());
    } catch {
      // A transport failure and a malformed answer are the SAME event here —
      // "we did not learn anything this time" — and both are handled below by
      // ageing the previous read rather than by blanking it.
      track = null;
    }

    // The station may have changed while this was in flight. Writing anyway
    // would caption the new station with the old one's track, which `/np`
    // would then publish into a channel. Compared by URL rather than by a
    // generation counter, which also makes a re-tune of the SAME station
    // accept the answer it is still waiting for.
    if (tunedStation()?.songsUrl !== url) return;

    if (track !== null) {
      setRead({ track, at: Date.now() });
      setStaleFlag(false);
      return;
    }
    const last = read();
    if (last !== null && Date.now() - last.at > NOW_PLAYING_STALE_MS) setStaleFlag(true);
  };

  // The lifecycle, derived. Every transition that matters — tuning, swapping,
  // an upload seizing the player, the ✕, a logout — arrives here as one
  // `tunedStation()` change, because that value is itself derived from the one
  // audio store. There is nothing else to hook and nothing to keep in step.
  createEffect(
    on(tunedStation, (station) => {
      stopPolling();
      setRead(null);
      setStaleFlag(false);
      const url = station?.songsUrl;
      if (url === undefined || url === null) return;
      // Immediately, then on the interval: a 60s blank at tune-in is the
      // operator's first impression of the feature.
      void poll(url);
      timer = setInterval(() => void poll(url), NOW_PLAYING_POLL_MS);
    }),
  );

  const nowPlaying = (): NowPlaying => {
    const station = tunedStation();
    if (station === null) return { status: "idle" };
    if (station.songsUrl === null) return { status: "unsupported" };
    if (staleFlag()) return { status: "stale" };
    const last = read();
    if (last === null) return { status: "unanswered" };
    return { status: "playing", track: last.track };
  };

  return { nowPlaying };
});

export const { nowPlaying } = exports_;
