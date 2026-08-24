import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  audioFailureLabel,
  clearPlaybackFailure,
  closeAudio,
  playAudio,
  reportPlaybackFailure,
} from "../lib/audioPlayer";
import { setToken } from "../lib/auth";
import {
  applyMediaSession,
  mediaSessionMetadata,
  setMediaSessionHandlers,
  setMediaSessionPlaybackState,
} from "../lib/mediaSession";
import { NOW_PLAYING_POLL_MS, NOW_PLAYING_STALE_MS } from "../lib/nowPlaying";
import { tuneStation } from "../lib/radio";
import { RADIO_STATIONS, type RadioStation } from "../lib/radioStations";

// #1702 — Media Session metadata. On an iOS lock screen the player showed only
// the app name; nothing ever told the OS what was on.
//
// Two properties carry this file. The projection must name the TRACK when we
// have one and the STATION when we do not (the spec's literal mapping would
// have put the track title in the `artist` slot, burying it), and it must never
// assert a track the rest of cic has already stopped believing — the `stale`
// arm is the one that decides that.

/** A station whose logo is a `.jpg`, and one whose logo is a `.png`. #1696
    proved the extension is per-station, so the artwork `type` must be READ off
    the URL rather than assumed; a test pinned to one extension would pass while
    the other half of the table shipped the wrong mime. */
const jpgStation = RADIO_STATIONS.find((s) => s.logoUrl?.endsWith(".jpg") === true);
const pngStation = RADIO_STATIONS.find((s) => s.logoUrl?.endsWith(".png") === true);
if (jpgStation === undefined || pngStation === undefined) {
  throw new Error("these tests need one .jpg-logo and one .png-logo station in the curated table");
}
const feedUrl = jpgStation.songsUrl;
if (feedUrl === null) {
  throw new Error("this test needs a station that publishes a now-playing feed");
}

/** A provider with no track feed — the `unsupported` arm. Constructed rather
    than found, because no real row is null today and a skipped test is
    silence. */
const feedless: RadioStation = {
  ...jpgStation,
  id: "feedless",
  title: "Feedless FM",
  streamUrl: "https://stream.example.org/feedless",
  songsUrl: null,
};

const okOnce = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const songsBody = (songs: ReadonlyArray<Record<string, string>>): unknown => ({
  id: jpgStation.id,
  songs,
});

/** Drain the `void fetch(...)` chain without letting the poll interval fire. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** Tune `station` and let one feed answer land. */
const tuneWithTrack = async (
  station: RadioStation,
  song: Record<string, string>,
): Promise<void> => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => okOnce(songsBody([song]))),
  );
  tuneStation(station);
  await settle();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-24T03:00:00Z"));
});

afterEach(() => {
  closeAudio();
  clearPlaybackFailure();
  setToken(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mediaSessionMetadata", () => {
  it("is null when nothing is playing", () => {
    expect(mediaSessionMetadata()).toBeNull();
  });

  it("names the TRACK in title and the STATION in album once a track is known", async () => {
    await tuneWithTrack(jpgStation, { artist: "Steve Roach", title: "Structures from Silence" });

    expect(mediaSessionMetadata()).toEqual({
      title: "Structures from Silence",
      artist: "Steve Roach",
      album: jpgStation.title,
      artwork: [{ src: jpgStation.logoUrl, type: "image/jpeg" }],
    });
  });

  it("falls back to the STATION in title while no track has been learned", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okOnce(songsBody([]))),
    );
    tuneStation(jpgStation);

    // No `settle()`: the feed has not answered, which is the `unanswered` arm.
    expect(mediaSessionMetadata()).toEqual({
      title: jpgStation.title,
      artist: "",
      album: "",
      artwork: [{ src: jpgStation.logoUrl, type: "image/jpeg" }],
    });
  });

  it("names the station alone when the provider publishes no feed", () => {
    tuneStation(feedless);

    expect(mediaSessionMetadata()?.title).toBe("Feedless FM");
    expect(mediaSessionMetadata()?.artist).toBe("");
  });

  it("leaves artist empty when the feed gave a blank one", async () => {
    await tuneWithTrack(jpgStation, { title: "Unattributed" });

    expect(mediaSessionMetadata()).toMatchObject({ title: "Unattributed", artist: "" });
  });

  it("reads the artwork mime off the URL, so a .png station is not shipped as jpeg", () => {
    tuneStation(pngStation);

    expect(mediaSessionMetadata()?.artwork).toEqual([
      { src: pngStation.logoUrl, type: "image/png" },
    ]);
  });

  it("stops asserting the track once the read has gone stale", async () => {
    await tuneWithTrack(jpgStation, { artist: "Steve Roach", title: "Structures from Silence" });
    expect(mediaSessionMetadata()?.title).toBe("Structures from Silence");

    // Every later poll fails, long enough for the store to flag the read stale.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("feed down");
      }),
    );
    await vi.advanceTimersByTimeAsync(NOW_PLAYING_STALE_MS + NOW_PLAYING_POLL_MS);

    // The lock screen must not keep naming a track cic has stopped believing.
    expect(mediaSessionMetadata()).toMatchObject({ title: jpgStation.title, artist: "" });
  });

  it("names an upload by its slug, with no artwork to borrow", () => {
    // `null` label spelled out: `playAudio` takes both since #682 and cic
    // forbids default arguments, so an upload states that it has no name.
    playAudio("https://grappa.example/uploads/f00ba7.mp3", null);

    expect(mediaSessionMetadata()).toEqual({
      title: "f00ba7.mp3",
      artist: "",
      album: "",
      artwork: [],
    });
  });

  it("hands the OS NO artwork for a station that publishes none (#1704)", () => {
    // The same answer an upload gets two cases up, and for the same reason: an
    // empty `artwork` lets the platform keep the app icon rather than be handed
    // something that is not the station's. Our own placeholder is deliberately
    // not sent — it is an SVG built for one 120px slot in the rail, and
    // `MediaImage` support for SVG is not something this codebase has measured
    // on any platform.
    const logoless = RADIO_STATIONS.find((s) => s.logoUrl === null);
    if (logoless === undefined) throw new Error("this test needs a logo-less station in the table");

    tuneStation(logoless);

    expect(mediaSessionMetadata()).toEqual({
      title: logoless.title,
      artist: "",
      album: "",
      artwork: [],
    });
  });

  // #1744 — the OS is the FOURTH surface, and on a phone it is often the only
  // one: the screen is locked, the docked bar is behind it, and the rail is a
  // drawer slid off-screen. A lock screen that reads "SomaFM Metal" over a
  // stream that never decoded is the same silence as the bar's, one layer out.
  //
  // WHY THE ARTIST SLOT. It is the second line, and on a failure there is no
  // track and therefore no artist to displace — the projection's `title` keeps
  // naming the SOURCE, which is what makes the sentence complete ("Groove
  // Salad / connection lost"). Putting the failure in `title` would cost the
  // operator the name of the thing that failed.
  //
  // WHY `playbackState` IS DELIBERATELY LEFT AT "paused". The states the
  // platform defines are `none | paused | playing`, and "none" is the only one
  // that could carry "broken" — but a UA is free to drop the whole now-playing
  // card on "none", which would take the sentence above off the screen with it.
  // Read off the Media Session spec, not measured on a device: the safe move is
  // to keep the card (and its retry button, which `playNow` already re-fetches
  // through) and let the TEXT carry the fact.
  describe("a source that will not play (#1744)", () => {
    it("hands the failure to the lock screen beside the station's name", () => {
      tuneStation(jpgStation);

      reportPlaybackFailure({ code: 2, message: "" } as MediaError);

      expect(mediaSessionMetadata()).toEqual({
        title: jpgStation.title,
        artist: audioFailureLabel("network"),
        album: "",
        artwork: [{ src: jpgStation.logoUrl, type: "image/jpeg" }],
      });
    });

    it("stops naming a track the operator cannot hear", async () => {
      // Same rule the `stale` arm above obeys, from the other direction: cic
      // must not assert to the OS something it has stopped telling the
      // operator. The feed keeps answering — it polls the station, and the
      // station is derived from the SOURCE, which a decode failure does not
      // touch.
      await tuneWithTrack(jpgStation, { artist: "Steve Roach", title: "Structures from Silence" });
      expect(mediaSessionMetadata()?.title).toBe("Structures from Silence");

      reportPlaybackFailure({ code: 4, message: "" } as MediaError);

      expect(mediaSessionMetadata()).toMatchObject({
        title: jpgStation.title,
        artist: audioFailureLabel("unsupported"),
      });
    });

    it("says it for an upload too, which has no station to name", () => {
      playAudio("https://grappa.example/uploads/f00ba7.mp3", null);

      reportPlaybackFailure({ code: 3, message: "" } as MediaError);

      expect(mediaSessionMetadata()).toEqual({
        title: "f00ba7.mp3",
        artist: audioFailureLabel("decode"),
        album: "",
        artwork: [],
      });
    });

    it("goes quiet again as soon as another source is tuned", () => {
      tuneStation(jpgStation);
      reportPlaybackFailure({ code: 2, message: "" } as MediaError);

      tuneStation(pngStation);

      expect(mediaSessionMetadata()?.artist).toBe("");
    });
  });
});

describe("applyMediaSession", () => {
  it("hands the projection to the platform", () => {
    const session = { metadata: null } as unknown as MediaSession;
    vi.stubGlobal("navigator", { mediaSession: session });
    vi.stubGlobal(
      "MediaMetadata",
      class {
        constructor(readonly init: unknown) {}
      },
    );

    applyMediaSession({
      title: "T",
      artist: "A",
      album: "S",
      artwork: [{ src: "https://x/y.png", type: "image/png" }],
    });

    expect((session.metadata as unknown as { init: unknown })?.init).toEqual({
      title: "T",
      artist: "A",
      album: "S",
      artwork: [{ src: "https://x/y.png", type: "image/png" }],
    });
  });

  it("clears the platform metadata when nothing is playing", () => {
    const session = { metadata: {} } as unknown as MediaSession;
    vi.stubGlobal("navigator", { mediaSession: session });

    applyMediaSession(null);

    expect(session.metadata).toBeNull();
  });

  it("is a no-op where the platform has no Media Session at all", () => {
    vi.stubGlobal("navigator", {});

    // The assertion is that this does not throw: every non-iOS browser without
    // the API must keep playing audio exactly as before.
    expect(() => {
      applyMediaSession({ title: "T", artist: "", album: "", artwork: [] });
    }).not.toThrow();
  });
});

describe("setMediaSessionHandlers", () => {
  it("points the lock-screen transport at the callbacks it is given", () => {
    const handlers = new Map<string, () => void>();
    vi.stubGlobal("navigator", {
      mediaSession: {
        setActionHandler: (action: string, fn: (() => void) | null) => {
          if (fn === null) handlers.delete(action);
          else handlers.set(action, fn);
        },
      },
    });
    const play = vi.fn();
    const pause = vi.fn();

    setMediaSessionHandlers({ play, pause });
    handlers.get("play")?.();
    handlers.get("pause")?.();

    expect(play).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledOnce();
  });

  it("unregisters both handlers when handed null", () => {
    const handlers = new Map<string, () => void>();
    vi.stubGlobal("navigator", {
      mediaSession: {
        setActionHandler: (action: string, fn: (() => void) | null) => {
          if (fn === null) handlers.delete(action);
          else handlers.set(action, fn);
        },
      },
    });

    setMediaSessionHandlers({ play: vi.fn(), pause: vi.fn() });
    setMediaSessionHandlers(null);

    expect(handlers.size).toBe(0);
  });

  it("is a no-op where the platform has no Media Session at all", () => {
    vi.stubGlobal("navigator", {});

    expect(() => {
      setMediaSessionHandlers({ play: vi.fn(), pause: vi.fn() });
    }).not.toThrow();
  });
});

describe("setMediaSessionPlaybackState", () => {
  it("mirrors the element's state so the lock-screen glyph is not the OS guessing", () => {
    const session = { playbackState: "none" } as unknown as MediaSession;
    vi.stubGlobal("navigator", { mediaSession: session });

    setMediaSessionPlaybackState("playing");
    expect(session.playbackState).toBe("playing");

    setMediaSessionPlaybackState("paused");
    expect(session.playbackState).toBe("paused");
  });

  it("is a no-op where the platform has no Media Session at all", () => {
    vi.stubGlobal("navigator", {});

    expect(() => {
      setMediaSessionPlaybackState("playing");
    }).not.toThrow();
  });
});
