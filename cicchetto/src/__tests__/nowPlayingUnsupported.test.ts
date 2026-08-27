import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW_PLAYING_POLL_MS, nowPlaying } from "../lib/nowPlaying";
import type { RadioStation } from "../lib/radioStations";

// #1698 — the `unsupported` arm, which needs its own file.
//
// `nowPlayingSource` is nullable because publishing a now-playing feed is a
// provider CAPABILITY, and the type therefore FORCES `nowPlaying()` to answer
// something for a station that has none. Answering `idle` would be a lie — a
// station IS tuned — so the arm exists, and it must be tested.
//
// #1835 — WHAT NULL STILL MEANS, now that it means less. The field used to be
// `songsUrl`, so null said BOTH "no feed" and "not a shape we can read", and
// Kohina was filed under it while its icecast published a title all along. With
// one reader per vendor, null is only the first of those. This arm is therefore
// narrower and more honest than it was, and it still has to exist:
// rockantenne-metal publishes nothing at all.
//
// Mocking rather than reaching for that real row: a test bound to whichever
// station happens to be feedless today goes green-and-vacuous the day someone
// finds it a feed, which is exactly the edit this file protects against.
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
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://example.org/logo.png",
    nowPlayingSource: null,
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
    expect(nowPlaying()).toEqual({ status: "unsupported", station: "Feedless FM" });
  });

  it("never touches the network for it", async () => {
    // The other half: a station with no feed must not be probed once, let
    // alone every minute forever, at some third party's expense.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await vi.advanceTimersByTimeAsync(NOW_PLAYING_POLL_MS * 5);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // `/np`'s arm for this state, tested against the HANDLER rather than through
  // `compose.submit` like every other verb. Not a preference: the dispatcher
  // can only be driven into this state by tuning a station the curated table
  // holds, and no such row is feedless — so the arm is unreachable from there,
  // and the alternative to this test is a production switch arm with no test
  // at all. Reached here because the mock above is already the station it
  // needs.
  it("tells `/np` to refuse, naming the station and the reason", async () => {
    const sendMessage = vi.fn();
    vi.doMock("../lib/scrollback", () => ({ sendMessage }));
    const { npCommand } = await import("../lib/commands/radio");

    // A context that THROWS on any read. The arm must decide from the store
    // alone — it has no window to send to and no network to resolve — so
    // touching the record at all is the bug, and this makes that a failure
    // rather than a detail nobody checks.
    const hostileCtx = new Proxy(
      {},
      {
        get(_t, prop) {
          throw new Error(`/np's refusal read ctx.${String(prop)}`);
        },
      },
    ) as unknown as Parameters<typeof npCommand>[1];

    const result = await npCommand({ kind: "np" }, hostileCtx);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ error: "/np: Feedless FM publishes no track information" });
  });
});
