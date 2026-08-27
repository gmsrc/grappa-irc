import { assertNever } from "./api";
import type { NowPlayingSource } from "./radioStations";

// #1835 — ONE READER PER VENDOR, and nothing reactive.
//
// The pure half of `nowPlaying.ts`: the parsers that turn a third party's
// document into a track, split out so they can be imported without opening the
// store's reactive root. That split is not tidiness — it is the same one
// `check-radio-logos-core.ts` states its own reason for. `bun run check:radio`
// must be able to run the PRODUCTION parser against a live feed (it is the only
// executable check on a hand-copied `mount`), and importing `nowPlaying.ts`
// from a bun script would eagerly run `moduleRoot`, creating a `createEffect`
// over `tunedStation()` in a process with no DOM and no identity.
//
// So: no solid-js here, no state, no IO. Every function is total on `unknown`.
//
// WHAT A PARSER OWES ITS CALLER, and it is the same contract for every vendor:
//
//   * NEVER THROW. A malformed answer is "we did not learn anything this time",
//     which the poll handles by ageing the previous read rather than blanking
//     it — and it cannot do that if parsing takes the caller out.
//   * NEVER YIELD A BLANK TITLE. `/np` renders a track into a CHANNEL, so the
//     empty sentence has to die at the door and not three layers downstream.
//   * NEVER INVENT A FIELD THE DOCUMENT DOES NOT CARRY. This is the rule that
//     shaped the whole issue: see `parseIcecastStatus`.

/** The track on air. `album` is in the somafm feed and deliberately NOT here:
    nothing renders it, and a field no door reads is a field that rots
    unnoticed. */
export type NowPlayingTrack = {
  /** Absent when the feed gave a blank one, or — for a vendor that publishes
      one joined string — when there is no honest way to know it. The line then
      names the title alone rather than dangling a dash. */
  readonly artist: string | null;
  readonly title: string;
};

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

/** The shape an Icecast `status-json.xsl` gives us. Optional throughout for the
    reason `SongsBody` states, plus one of its own: `source` is a LIST because
    one status document describes every mount the server carries, and the mount
    we stream is picked out of it by path rather than assumed to be first. */
type IcestatsBody = { readonly icestats?: { readonly source?: unknown } };

/** The mount path an icecast source is served at, or `null` when the row does
 * not name one we can read.
 *
 * `listenurl` is the ONLY mount identity Icecast 2.4.4 puts in this document —
 * there is no bare `mount` key — and it is parsed for its PATH and nothing
 * else. Measured on Kohina 2026-08-27, that URL reads
 * `http://localhost:8000/stream.ogg`: the icecast sits behind a reverse proxy
 * that does not rewrite it, so its host, scheme and port describe the server's
 * own loopback and say nothing about how anyone reaches it. Comparing whole
 * URLs would therefore match nothing, forever, and silently.
 */
function mountOf(row: Record<string, unknown>): string | null {
  const listenurl = str(row.listenurl);
  if (listenurl === "") return null;
  try {
    return new URL(listenurl).pathname;
  } catch {
    return null;
  }
}

/**
 * The track on `mount` in an Icecast `status-json.xsl` body, as ONE OPAQUE
 * LINE, or `null` when the document carries none we would show.
 *
 * 🔴 IT DOES NOT SPLIT, AND THAT IS THE DESIGN. Icecast carries a single
 * `title` string with no agreed internal structure. Measured on Kohina twice:
 * `Hisayoshi Ogura (Zuntata) - The Ninja Warriors - Che! - Arcade` and
 * `Yuzo Koshiro - SOR2 - Good End - Mega Drive` — FOUR segments on `" - "`,
 * spelling `<composer> - <game> - <track> - <platform>`. Splitting on the first
 * dash puts a composer in `artist` and three joined facts in `title`; splitting
 * on the last is worse. There is no separator to trust, so `artist` is `null`
 * BY CONSTRUCTION here rather than by absence in the feed, and the line is
 * shown whole. `nowPlaying.ts`'s header already refused SomaFM's `lastPlaying`
 * for exactly this reason; re-introducing the split for a different vendor
 * would be reopening a door the module shut on itself.
 *
 * A blank title is refused at this door, like `parseSongsFeed`'s: `/np` renders
 * the track into a channel and a blank one is the empty sentence that must
 * never reach the wire.
 *
 * A `source` that is not an ARRAY yields `null` rather than a guess. A
 * single-mount icecast is reported to answer with a bare object instead, and we
 * have no such server to measure — so it degrades to "no track" and would be
 * caught LOUDLY by `bun run check:radio`'s FEED axis before such a station
 * could ship, rather than handled here on an unverifiable claim.
 */
export function parseIcecastStatus(body: unknown, mount: string): NowPlayingTrack | null {
  if (typeof body !== "object" || body === null) return null;
  const icestats = (body as IcestatsBody).icestats;
  if (typeof icestats !== "object" || icestats === null) return null;
  const sources = icestats.source;
  if (!Array.isArray(sources)) return null;

  for (const entry of sources) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (mountOf(row) !== mount) continue;
    const title = str(row.title);
    return title === "" ? null : { artist: null, title };
  }
  return null;
}

/**
 * The track a station's declared source is currently naming, or `null`.
 *
 * The one door the poll goes through, and the reason `kind` is a closed union:
 * a vendor added to `NowPlayingSource` without an arm here widens the parameter
 * away from `never` and `tsc` rejects the `assertNever` call. The alternative —
 * a string field and a lookup that returns undefined — would ship a station
 * that reads `unanswered` forever with nothing anywhere saying why.
 */
export function parseNowPlayingFeed(
  source: NowPlayingSource,
  body: unknown,
): NowPlayingTrack | null {
  switch (source.kind) {
    case "somafm":
      return parseSongsFeed(body);
    case "icecast-status":
      return parseIcecastStatus(body, source.mount);
    default:
      return assertNever(source);
  }
}
