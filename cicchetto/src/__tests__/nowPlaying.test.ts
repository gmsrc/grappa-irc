import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAudio, playAudio } from "../lib/audioPlayer";
import { setToken } from "../lib/auth";
import {
  NOW_PLAYING_POLL_MS,
  NOW_PLAYING_STALE_MS,
  nowPlaying,
  nowPlayingLine,
} from "../lib/nowPlaying";
import {
  type NowPlayingTrack,
  parseIcecastStatus,
  parseNowPlayingFeed,
  parseSongsFeed,
} from "../lib/nowPlayingFeeds";
import { tuneStation } from "../lib/radio";
import { RADIO_STATIONS, type RadioStation } from "../lib/radioStations";

// #1698 — the now-playing store.
//
// Two properties carry the whole file. The store must never claim a track it
// cannot stand behind (that is what `/np` publishes into a channel), and it
// must never poll a third party for a player that is off.

const station = RADIO_STATIONS[0];
const other = RADIO_STATIONS[1];
if (station === undefined || other === undefined) {
  throw new Error("the curated table must carry at least two stations for these tests");
}
// Narrowed once: `nowPlayingSource` is nullable in the type and these tests are
// about the arm where it is present. A row that lost its feed would otherwise
// make them pass while probing nothing.
const source = station.nowPlayingSource;
const otherSource = other.nowPlayingSource;
if (source === null || otherSource === null) {
  throw new Error("these tests need two stations that publish a now-playing feed");
}
const feedUrl = source.url;
const otherFeedUrl = otherSource.url;

// #1835 — the SECOND vendor shape, taken from the real table rather than
// invented. A positive control by construction: the moment the table holds no
// `icecast-status` row, every assertion below it stops being reachable and this
// throws instead of reporting a green built from zero comparisons.
const icecastStation = RADIO_STATIONS.find((s) => s.nowPlayingSource?.kind === "icecast-status");
const icecastSource = icecastStation?.nowPlayingSource;
if (icecastStation === undefined || icecastSource?.kind !== "icecast-status") {
  throw new Error("these tests need a station whose feed is an icecast status document");
}

/** A station from a provider with no track feed — the null arm of
    `nowPlayingSource`. Constructed rather than taken from the table, and the
    reason is that it must be OUTSIDE it: the one test that uses it asserts that
    an untabled station is not tunable at all. (Real null rows do exist —
    rockantenne-metal since #1703 — so this is not standing in for an empty
    arm.) */
const feedless: RadioStation = {
  ...station,
  id: "feedless",
  title: "Feedless FM",
  streamUrl: "https://stream.example.org/feedless",
  nowPlayingSource: null,
};

const songsBody = (
  songs: ReadonlyArray<Record<string, string>>,
): { id: string; songs: ReadonlyArray<Record<string, string>> } => ({
  id: station.id,
  songs,
});

/** One 200 carrying `body`. */
const okOnce = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

/** Flush the microtasks a `void fetch(...)` chain needs, without letting the
    poll interval fire. `advanceTimersByTimeAsync(0)` is the vitest verb that
    drains the queue under fake timers — an `await Promise.resolve()` drains
    only one tick and the chain here is longer than one. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-24T03:00:00Z"));
});

afterEach(() => {
  closeAudio();
  setToken(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("parseSongsFeed", () => {
  // The third-party boundary. Every case here is a document SomaFM could hand
  // us; none of them may throw, and none may yield a track the `/np` line
  // would render as an empty sentence.
  it("reads the newest song out of the feed", () => {
    expect(
      parseSongsFeed({
        id: "groovesalad",
        songs: [
          { title: "A Land Unknown", artist: "Trestal", album: "Ceramic Illumination" },
          { title: "older", artist: "someone else" },
        ],
      }),
    ).toEqual({ artist: "Trestal", title: "A Land Unknown" });
  });

  it("refuses a feed with no songs rather than inventing a blank track", () => {
    expect(parseSongsFeed({ id: "groovesalad", songs: [] })).toBeNull();
  });

  it("refuses a document with no songs key at all", () => {
    expect(parseSongsFeed({ id: "groovesalad" })).toBeNull();
  });

  it("refuses a song whose title is empty — the empty line, caught at the door", () => {
    // The failure worth naming: a blank title renders `* nick is now playing:
    // Trestal —  [Groove Salad]` into a channel. Refusing here is what makes
    // the whole rest of the pipeline unable to publish one.
    expect(parseSongsFeed(songsBody([{ title: "   ", artist: "Trestal" }]))).toBeNull();
  });

  it("keeps a titled song whose artist is empty, with no artist", () => {
    // Measured 2026-08-24 across all 14 stations: 0 of 237 songs had an empty
    // artist or title. That is a sample, not a contract, so an absent artist
    // degrades to a shorter line rather than to no line.
    expect(parseSongsFeed(songsBody([{ title: "Untitled Drone", artist: "" }]))).toEqual({
      artist: null,
      title: "Untitled Drone",
    });
  });

  it("survives garbage rather than throwing at the caller", () => {
    // A crash here would take out the poll's error handling, whose whole job
    // is to keep the previous track on screen through a bad answer.
    expect(parseSongsFeed(null)).toBeNull();
    expect(parseSongsFeed("not json at all")).toBeNull();
    expect(parseSongsFeed({ songs: "not an array" })).toBeNull();
    expect(parseSongsFeed({ songs: [42] })).toBeNull();
  });
});

// #1835 — the icecast `status-json.xsl` document, in the shape Kohina's server
// actually answers with. Measured 2026-08-27 against
// `https://kohina.brona.dk/icecast/status-json.xsl`: HTTP 200,
// `application/json`, `Access-Control-Allow-Origin: *`, Icecast 2.4.4, THREE
// mounts, and every `listenurl` on `http://localhost:8000/...` because the
// icecast sits behind a reverse proxy that does not rewrite it.
const mountSource = (mount: string, over: Record<string, unknown>): Record<string, unknown> => ({
  listenurl: `http://localhost:8000${mount}`,
  server_name: "Kohina - Old School Game and Demo Music",
  server_description: "Hand picked chip tunes from classic computers and consoles.",
  ...over,
});

const icecastBody = (sources: readonly Record<string, unknown>[]): unknown => ({
  icestats: { server_id: "Icecast 2.4.4", host: "localhost", source: sources },
});

/** The title as measured, and the whole reason this vendor renders opaquely:
    FOUR segments on `" - "`, artist not recoverable by any split. */
const OPAQUE_TITLE = "Yuzo Koshiro - SOR2 - Good End - Mega Drive";

describe("parseIcecastStatus", () => {
  it("renders the mount's title as ONE opaque line, inventing no artist", () => {
    // The load-bearing assertion of the whole slice. `" - "` appears three
    // times and none of them is an artist boundary — the string is
    // `<composer> - <game> - <track> - <platform>`. A split-and-hope would put
    // "Yuzo Koshiro" in `artist` and "SOR2 - Good End - Mega Drive" in `title`,
    // which is wrong here and unfixably wrong in general, and it is exactly the
    // shape `nowPlaying.ts`'s header already refused for SomaFM's `lastPlaying`.
    expect(
      parseIcecastStatus(
        icecastBody([mountSource("/stream.ogg", { title: OPAQUE_TITLE })]),
        "/stream.ogg",
      ),
    ).toEqual({ artist: null, title: OPAQUE_TITLE });
  });

  it("takes the title from the mount asked for, not from the first source", () => {
    // Measured: this server publishes three mounts off ONE status document, and
    // the row we ship is the ogg. Reading `source[0]` would caption our stream
    // with the aac mount's title — which is the same track today and is not
    // guaranteed to be, since each mount is a separate icecast source.
    expect(
      parseIcecastStatus(
        icecastBody([
          mountSource("/stream.aac", { title: "aac mount track" }),
          mountSource("/stream.ogg", { title: OPAQUE_TITLE }),
          mountSource("/stream.opus", {}),
        ]),
        "/stream.ogg",
      ),
    ).toEqual({ artist: null, title: OPAQUE_TITLE });
  });

  it("matches the mount on the listenurl PATH, never on the whole URL", () => {
    // The measured trap. `listenurl` names `http://localhost:8000/stream.ogg`
    // while our station streams from `https://kohina.brona.dk/icecast/stream.ogg`
    // — neither the host, the scheme nor the path prefix agree. A comparison
    // against the stream URL would match nothing and the row would read
    // `unanswered` forever, silently.
    const body = icecastBody([mountSource("/stream.ogg", { title: OPAQUE_TITLE })]);
    expect(parseIcecastStatus(body, icecastStation.streamUrl)).toBeNull();
    expect(parseIcecastStatus(body, "/stream.ogg")).toEqual({
      artist: null,
      title: OPAQUE_TITLE,
    });
  });

  it("refuses a mount the document does not carry rather than guessing one", () => {
    // A mistyped `mount` in the table must read as "no track", not as some
    // other mount's track. This is the arm that makes `check:radio`'s FEED
    // probe able to catch the typo at all.
    expect(
      parseIcecastStatus(
        icecastBody([mountSource("/stream.ogg", { title: OPAQUE_TITLE })]),
        "/stream.mp3",
      ),
    ).toBeNull();
  });

  it("refuses a mount with no title key at all", () => {
    // Measured: the opus mount answers with no `title` whatsoever. A source
    // that is up and silent about what it is playing is not a track.
    expect(
      parseIcecastStatus(icecastBody([mountSource("/stream.opus", {})]), "/stream.opus"),
    ).toBeNull();
  });

  it("refuses a blank title — the empty line, caught at the same door", () => {
    // The icecast twin of `parseSongsFeed`'s blank-title rule. Without it
    // `/np` publishes `* nick is now playing:  [Kohina]` into a channel, and
    // the rail draws a caption made of nothing.
    expect(
      parseIcecastStatus(
        icecastBody([mountSource("/stream.ogg", { title: "   " })]),
        "/stream.ogg",
      ),
    ).toBeNull();
  });

  it("survives garbage rather than throwing at the caller", () => {
    // Same contract `parseSongsFeed` states: a crash here takes out the poll's
    // error handling, whose whole job is to keep the previous track on screen
    // through a bad answer.
    expect(parseIcecastStatus(null, "/stream.ogg")).toBeNull();
    expect(parseIcecastStatus("not json at all", "/stream.ogg")).toBeNull();
    expect(parseIcecastStatus({ icestats: null }, "/stream.ogg")).toBeNull();
    // A single-mount icecast is REPORTED to answer `source` as a bare object
    // rather than a one-element array. Unmeasured — we have no single-mount
    // server to point at — so it is deliberately NOT handled: it degrades to
    // "no track", never to a throw, and inventing the branch would be the
    // unverifiable claim #1696 was filed about. `check:radio`'s FEED axis is
    // where such a station would go red, loudly, before it ever shipped.
    expect(parseIcecastStatus({ icestats: { source: { title: "x" } } }, "/stream.ogg")).toBeNull();
    expect(parseIcecastStatus({ icestats: { source: [42] } }, "/stream.ogg")).toBeNull();
    expect(
      parseIcecastStatus({ icestats: { source: [{ title: "x" }] } }, "/stream.ogg"),
    ).toBeNull();
    expect(
      parseIcecastStatus(
        { icestats: { source: [{ listenurl: "://not a url", title: "x" }] } },
        "/stream.ogg",
      ),
    ).toBeNull();
  });
});

describe("parseNowPlayingFeed", () => {
  // The dispatcher is what makes `kind` a CLOSED set with teeth: a third vendor
  // added to the union without an arm here is a compile error at `assertNever`,
  // not a station that silently reads `unanswered`.
  it("reads a somafm body through the somafm arm — title and artist stay SPLIT", () => {
    // The non-regression that matters: the vendor that CAN separate the two
    // still does. Collapsing SomaFM into the opaque shape "for consistency"
    // would lose a fact we are given.
    expect(
      parseNowPlayingFeed(
        { kind: "somafm", url: feedUrl },
        songsBody([{ title: "A Land Unknown", artist: "Trestal" }]),
      ),
    ).toEqual({ artist: "Trestal", title: "A Land Unknown" });
  });

  it("reads an icecast body through the icecast arm, at the descriptor's mount", () => {
    expect(
      parseNowPlayingFeed(
        icecastSource,
        icecastBody([
          mountSource("/stream.aac", { title: "aac mount track" }),
          mountSource(icecastSource.mount, { title: OPAQUE_TITLE }),
        ]),
      ),
    ).toEqual({ artist: null, title: OPAQUE_TITLE });
  });

  it("hands each vendor's body to its OWN reader and to no other", () => {
    // Crossed on purpose. Each parser must fail to find a track in the other
    // vendor's document — if either one accidentally read the other's shape,
    // the dispatch would be decoration and a mis-typed `kind` would go
    // unnoticed.
    expect(
      parseNowPlayingFeed(
        { kind: "somafm", url: feedUrl },
        icecastBody([mountSource("/stream.ogg", { title: OPAQUE_TITLE })]),
      ),
    ).toBeNull();
    expect(
      parseNowPlayingFeed(icecastSource, songsBody([{ title: "Juno", artist: "Setsuna" }])),
    ).toBeNull();
  });
});

describe("nowPlayingLine", () => {
  const track = (over: Partial<NowPlayingTrack>): NowPlayingTrack => ({
    artist: "Trestal",
    title: "A Land Unknown",
    ...over,
  });

  it("names the artist, the track and the station", () => {
    // The station is IN the line on purpose: it is the only part a reader can
    // act on. Without it the line is a boast; with it, it is a recommendation
    // someone else can tune to.
    expect(nowPlayingLine(track({}), "Groove Salad")).toBe(
      "is now playing: Trestal — A Land Unknown [Groove Salad]",
    );
  });

  it("drops the dash along with the artist rather than leaving it dangling", () => {
    expect(nowPlayingLine(track({ artist: null }), "Drone Zone")).toBe(
      "is now playing: A Land Unknown [Drone Zone]",
    );
  });
});

describe("nowPlaying store", () => {
  it("is idle with nothing tuned, and asks the network nothing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(nowPlaying()).toEqual({ status: "idle" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the feed the moment a station is tuned", async () => {
    // Immediately, not on the first interval tick: a 60s blank line at tune-in
    // is the operator's whole first impression of the feature.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okOnce(songsBody([{ title: "Juno", artist: "Setsuna" }])));
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(station);
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(feedUrl);
    expect(nowPlaying()).toEqual({
      status: "playing",
      track: { artist: "Setsuna", title: "Juno" },
      station: station.title,
    });
  });

  it("sends no credentials to the third party", async () => {
    // A cross-origin `fetch` omits cookies by default, but the default is a
    // default: state it, so a later edit that adds an options object cannot
    // silently turn it on.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okOnce(songsBody([{ title: "Juno", artist: "S" }])));
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(station);
    await settle();

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit" });
  });

  it("cannot be tuned to a station outside the curated table", () => {
    // Not a limitation to work around — it is why `nowPlayingUnsupported.test.ts`
    // exists as a separate file. `tunedStation()` matches the playing href
    // against RADIO_STATIONS, so a station the table does not hold is not
    // tunable at all, and the `unsupported` arm is unreachable from here.
    tuneStation(feedless);
    expect(nowPlaying()).toEqual({ status: "idle" });
  });

  it("re-reads on the poll interval while tuned", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okOnce(songsBody([{ title: "Juno", artist: "S" }])));
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(station);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(NOW_PLAYING_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(NOW_PLAYING_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops polling when the player is closed", async () => {
    // The issue's own requirement, and the one that decides whether this is a
    // polite guest on someone else's host: a stopped radio must cost SomaFM
    // nothing at all.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okOnce(songsBody([{ title: "Juno", artist: "S" }])));
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(station);
    await settle();
    const afterTune = fetchMock.mock.calls.length;

    closeAudio();
    await vi.advanceTimersByTimeAsync(NOW_PLAYING_POLL_MS * 5);

    expect(fetchMock).toHaveBeenCalledTimes(afterTune);
    expect(nowPlaying()).toEqual({ status: "idle" });
  });

  it("stops polling when an upload takes the one player over", async () => {
    // Same derivation `tunedStation` already relies on: there is ONE <audio>
    // element, so a clicked audio link un-tunes the station. A poll keyed on
    // anything but that fact would keep hammering the feed for a station that
    // is no longer playing.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okOnce(songsBody([{ title: "Juno", artist: "S" }])));
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(station);
    await settle();
    const afterTune = fetchMock.mock.calls.length;

    playAudio("https://grappa.example/uploads/abc", null);
    await vi.advanceTimersByTimeAsync(NOW_PLAYING_POLL_MS * 3);

    expect(fetchMock).toHaveBeenCalledTimes(afterTune);
    expect(nowPlaying()).toEqual({ status: "idle" });
  });

  it("switches feeds when a second station is tuned", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okOnce(songsBody([{ title: "Juno", artist: "S" }])));
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(station);
    await settle();
    tuneStation(other);
    await settle();

    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(otherFeedUrl);
  });

  it("shows no track from the previous station while the new one is loading", async () => {
    // A swap must blank, not carry over: the docked bar would otherwise
    // caption the new station with the old one's track, and `/np` would
    // publish that pairing into a channel.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okOnce(songsBody([{ title: "Juno", artist: "S" }])))
      .mockReturnValueOnce(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(station);
    await settle();
    expect(nowPlaying()).toMatchObject({ status: "playing" });

    tuneStation(other);
    await settle();
    expect(nowPlaying()).toEqual({ status: "unanswered", station: other.title });
  });

  it("does not let a fetch that outlives its station write the wrong track", async () => {
    // The race the swap opens. Station A's read is still in flight when the
    // operator tunes B; if it resolves into the store unguarded, B is captioned
    // with A's track and nothing anywhere says so.
    let resolveA: ((r: Response) => void) | undefined;
    const fetchMock = vi.fn((url: string) =>
      url === feedUrl
        ? new Promise<Response>((res) => {
            resolveA = res;
          })
        : Promise.resolve(okOnce(songsBody([{ title: "B track", artist: "B" }]))),
    );
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(station);
    await settle();
    tuneStation(other);
    await settle();
    expect(nowPlaying()).toEqual({
      status: "playing",
      track: { artist: "B", title: "B track" },
      station: other.title,
    });

    resolveA?.(okOnce(songsBody([{ title: "A track", artist: "A" }])));
    await settle();

    expect(nowPlaying()).toEqual({
      status: "playing",
      track: { artist: "B", title: "B track" },
      station: other.title,
    });
  });

  it("keeps the last track through a single failed read", async () => {
    // One blip must not blank the display: at a 60s cadence against a median
    // 259s track (measured 2026-08-24, 223 gaps), the track we hold is still
    // very likely the one on air.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okOnce(songsBody([{ title: "Juno", artist: "S" }])))
      .mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(station);
    await settle();
    await vi.advanceTimersByTimeAsync(NOW_PLAYING_POLL_MS);

    expect(nowPlaying()).toEqual({
      status: "playing",
      track: { artist: "S", title: "Juno" },
      station: station.title,
    });
  });

  it("goes stale once the last successful read is older than the threshold", async () => {
    // The state vjt asked to be decided rather than discovered: a ten-minute-
    // old track published into a channel is worse than a local error. Past the
    // threshold the store stops claiming a track at ALL — one predicate, so
    // `/np`'s refusal is not a special case bolted onto a display that lies.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okOnce(songsBody([{ title: "Juno", artist: "S" }])))
      .mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(station);
    await settle();
    await vi.advanceTimersByTimeAsync(NOW_PLAYING_STALE_MS + NOW_PLAYING_POLL_MS);

    expect(nowPlaying()).toEqual({ status: "stale", station: station.title });
  });

  it("recovers from stale when the feed answers again", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okOnce(songsBody([{ title: "Juno", artist: "S" }])))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(okOnce(songsBody([{ title: "Back", artist: "S" }])));
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(station);
    await settle();
    await vi.advanceTimersByTimeAsync(NOW_PLAYING_STALE_MS + NOW_PLAYING_POLL_MS);
    expect(nowPlaying()).toEqual({ status: "stale", station: station.title });

    await vi.advanceTimersByTimeAsync(NOW_PLAYING_POLL_MS);
    expect(nowPlaying()).toEqual({
      status: "playing",
      track: { artist: "S", title: "Back" },
      station: station.title,
    });
  });

  it("treats a non-2xx answer as a failed read, not as a track", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(station);
    await settle();

    expect(nowPlaying()).toEqual({ status: "unanswered", station: station.title });
  });

  it("stays unanswered — never pretends — when the feed has never answered", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(station);
    await settle();
    await vi.advanceTimersByTimeAsync(NOW_PLAYING_STALE_MS * 2);

    // NOT "stale": stale means "we had a track and it aged out". We never had
    // one, and saying otherwise would put a track-shaped hole where an
    // honest "the feed has not answered" belongs.
    expect(nowPlaying()).toEqual({ status: "unanswered", station: station.title });
  });

  it("plays an icecast station's opaque line, from the descriptor's own URL", async () => {
    // #1835, end to end through the real table row. The station that used to
    // land in `unsupported` with a muted band now names what is on — as ONE
    // line, with no artist, which is all this provider can honestly give.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okOnce(icecastBody([mountSource(icecastSource.mount, { title: OPAQUE_TITLE })])),
      );
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(icecastStation);
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(icecastSource.url);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit" });
    expect(nowPlaying()).toEqual({
      status: "playing",
      track: { artist: null, title: OPAQUE_TITLE },
      station: icecastStation.title,
    });
  });

  it("keeps an icecast station on the SAME cadence as every other vendor", async () => {
    // The brief's non-negotiable, pinned rather than trusted: a second vendor
    // must not quietly buy itself a tighter poll. One read at tune-in, then one
    // per interval, at a third party's expense exactly like SomaFM.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okOnce(icecastBody([mountSource(icecastSource.mount, { title: OPAQUE_TITLE })])),
      );
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(icecastStation);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(NOW_PLAYING_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    closeAudio();
    await vi.advanceTimersByTimeAsync(NOW_PLAYING_POLL_MS * 5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("publishes an icecast track as the opaque line `/np` would send", async () => {
    // The wire text, built by the production formatter rather than retyped.
    // The four `" - "` segments must arrive VERBATIM: any pipeline stage that
    // decided to split them would show up here as a mangled sentence.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okOnce(icecastBody([mountSource(icecastSource.mount, { title: OPAQUE_TITLE })])),
      );
    vi.stubGlobal("fetch", fetchMock);

    tuneStation(icecastStation);
    await settle();

    const state = nowPlaying();
    if (state.status !== "playing") throw new Error(`expected a track, got ${state.status}`);
    expect(nowPlayingLine(state.track, state.station)).toBe(
      `is now playing: ${OPAQUE_TITLE} [${icecastStation.title}]`,
    );
  });

  it("the stale threshold outlives more than one missed read", () => {
    // Pinned as a RELATION, not as a number: the threshold's whole
    // justification is that it is several poll intervals, so a future cadence
    // change must carry it along rather than silently collapse the two.
    expect(NOW_PLAYING_STALE_MS).toBeGreaterThan(NOW_PLAYING_POLL_MS * 2);
  });
});
