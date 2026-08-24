import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW_PLAYING_POLL_MS, nowPlaying } from "../lib/nowPlaying";
import type { RadioStation } from "../lib/radioStations";

// #1698 — the `unsupported` arm, which needs its own file.
//
// `songsUrl` is nullable because publishing a now-playing feed is a provider
// CAPABILITY, and the type therefore FORCES `nowPlaying()` to answer something
// for a station that has none. Answering `idle` would be a lie — a station IS
// tuned — so the arm exists, and it must be tested.
//
// It cannot be tested from `nowPlaying.test.ts`. `tunedStation()` derives the
// station by matching the playing href against RADIO_STATIONS, so only a table
// row can be tuned, and all fourteen rows carry a feed today. The arm is
// therefore unreachable in production RIGHT NOW and reachable the moment a row
// from another provider lands — which is exactly the edit this file protects.
//
// Mocking `../lib/radio` rather than adding a feedless row to the real table:
// production must not gain a fixture to make a test reachable (CLAUDE.md —
// never weaken production code to make tests pass). Its own file, because
// `vi.mock` is hoisted per-module and the sibling file needs the REAL store.

// The fixture lives INSIDE the factory, not beside it. `vi.mock` is hoisted
// above the module body, so a factory closing over a module-level `const`
// reads it in its temporal dead zone — measured here: the store's first effect
// threw `Cannot access 'feedless' before initialization`, `moduleRoot`'s error
// context logged it, and all the assertions below still went green. A green
// standing on a caught throw is not a green.
vi.mock("../lib/radio", () => {
  const feedless: RadioStation = {
    id: "feedless",
    title: "Feedless FM",
    genres: ["ambient"],
    description: "A station from a provider that publishes no track feed.",
    streamUrl: "https://stream.example.org/feedless",
    logoUrl: "https://example.org/logo.png",
    songsUrl: null,
  };
  return { tunedStation: (): RadioStation | null => feedless };
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a tuned station that publishes no now-playing feed", () => {
  it("says unsupported, not idle and not unanswered", () => {
    // Three states, three different facts. `idle` would deny that anything is
    // playing; `unanswered` would promise an answer that will never come and
    // send `/np` looking for one. `unsupported` is what was OBSERVED.
    expect(nowPlaying()).toEqual({ status: "unsupported" });
  });

  it("never touches the network for it", async () => {
    // The other half: a station with no feed must not be probed once, let
    // alone every minute forever, at some third party's expense.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await vi.advanceTimersByTimeAsync(NOW_PLAYING_POLL_MS * 5);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
