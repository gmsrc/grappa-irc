import { afterEach, describe, expect, it } from "vitest";
import {
  type AudioFailure,
  activeAudio,
  audioFailureLabel,
  clearPlaybackFailure,
  closeAudio,
  hidePlayer,
  playAudio,
  playbackFailure,
  playerHidden,
  reportPlaybackFailure,
  showPlayer,
} from "../lib/audioPlayer";
import { setToken } from "../lib/auth";

// Docked audio mini-player store (GH #115). Module-singleton signal —
// same identity-scoped pattern as mediaViewer.ts. One player instance:
// playAudio swaps the href, closeAudio clears, token rotation resets.

afterEach(() => {
  closeAudio();
  setToken(null);
});

describe("audioPlayer store", () => {
  it("starts with no active audio", () => {
    expect(activeAudio()).toBeNull();
  });

  it("playAudio sets the active href", () => {
    playAudio("https://grappa.example/uploads/abc", null);
    expect(activeAudio()).toEqual({ href: "https://grappa.example/uploads/abc", label: null });
  });

  it("playAudio on a second link swaps the source (one instance, not two)", () => {
    playAudio("https://grappa.example/uploads/first", null);
    playAudio("https://grappa.example/uploads/second", null);
    expect(activeAudio()).toEqual({ href: "https://grappa.example/uploads/second", label: null });
  });

  it("closeAudio clears the active audio", () => {
    playAudio("https://grappa.example/uploads/abc", null);
    closeAudio();
    expect(activeAudio()).toBeNull();
  });

  it("token rotation closes an open player (identity-scoped)", () => {
    setToken("tokA");
    playAudio("https://grappa.example/uploads/abc", null);
    expect(activeAudio()).not.toBeNull();

    setToken("tokB");
    expect(activeAudio()).toBeNull();
  });

  // #682 — the label rides WITH the href because the two must swap
  // atomically. A separate signal would let a station's name outlive the
  // source it named for one render, captioning an upload with the station
  // that preceded it.
  it("playAudio carries a label alongside the href", () => {
    playAudio("https://ice.somafm.com/groovesalad-128-mp3", "Groove Salad");
    expect(activeAudio()).toEqual({
      href: "https://ice.somafm.com/groovesalad-128-mp3",
      label: "Groove Salad",
    });
  });

  it("swapping a labelled source for an unlabelled one drops the label", () => {
    playAudio("https://ice.somafm.com/groovesalad-128-mp3", "Groove Salad");
    playAudio("https://grappa.example/uploads/abc", null);
    expect(activeAudio()).toEqual({ href: "https://grappa.example/uploads/abc", label: null });
  });
});

// #1697 — HIDING IS NOT STOPPING. `closeAudio` clears the source, and the
// element effect then pauses + detaches it; that is the STOP verb and it stays.
// Hiding is a third fact, orthogonal to both "there is a source" and "it is
// playing", and it gets its own signal.
describe("audioPlayer transport visibility (#1697)", () => {
  const STATION = "https://ice.somafm.com/groovesalad-128-mp3";

  afterEach(() => {
    showPlayer();
  });

  it("the transport starts shown", () => {
    expect(playerHidden()).toBe(false);
  });

  it("hidePlayer hides the transport", () => {
    playAudio(STATION, "Groove Salad");
    hidePlayer();
    expect(playerHidden()).toBe(true);
  });

  it("showPlayer brings it back", () => {
    playAudio(STATION, "Groove Salad");
    hidePlayer();
    showPlayer();
    expect(playerHidden()).toBe(false);
  });

  // THE load-bearing assertion, and it is `toBe`, not `toEqual`, on purpose.
  //
  // `AudioMiniPlayer` drives the element from `createEffect(on(activeAudio,…))`,
  // whose body assigns `audioEl.src` — and assigning `.src` re-invokes the media
  // load algorithm even when the URL is unchanged. So the ONLY shape of this
  // feature that does not restart the stream on every hide is one where the
  // source object's IDENTITY survives the gesture. Folding `hidden` into
  // `AudioPlayerState` (the shape #682 chose for `label`, which describes the
  // SOURCE) would hand back a fresh object here and turn a hide into a re-buffer.
  it("hiding does not touch the source object at all — same reference in, same out", () => {
    playAudio(STATION, "Groove Salad");
    const before = activeAudio();

    hidePlayer();

    expect(activeAudio()).toBe(before);
  });

  it("a new source always shows its transport — a hidden player cannot swallow it", () => {
    hidePlayer();
    playAudio("https://grappa.example/uploads/abc", null);
    expect(playerHidden()).toBe(false);
  });

  it("closing the player leaves no stale hidden flag behind", () => {
    playAudio(STATION, "Groove Salad");
    hidePlayer();
    closeAudio();
    expect(playerHidden()).toBe(false);
  });

  it("token rotation resets the flag with the rest of the store (identity-scoped)", () => {
    setToken("tokA");
    playAudio(STATION, "Groove Salad");
    hidePlayer();

    setToken("tokB");

    expect(playerHidden()).toBe(false);
    expect(activeAudio()).toBeNull();
  });
});

// #1744 — A SOURCE THAT WILL NOT PLAY. The element populates `el.error` and
// nothing was reading it for DISPLAY, so a station that never decoded looked
// exactly like one the operator had paused.
//
// A THIRD SIBLING SIGNAL, and by now that is a rule rather than a choice. The
// obvious home is a field on `AudioPlayerState` — and it is the same trap
// #1697 (`hidden`) and #1734 (`resumePoint`) each walked up to: `AudioMiniPlayer`
// drives the element from `createEffect(on(activeAudio, …))`, whose body assigns
// `audioEl.src`, and assigning `.src` re-invokes the media load algorithm even
// when the URL has not changed. A failure riding inside the state object would
// hand that effect a new reference and RESTART the source — on the very event
// that says the source cannot be started. Pinned below by the same
// same-reference assertion #1697 uses.
describe("audioPlayer playback failure (#1744)", () => {
  const STATION = "https://ice.somafm.com/groovesalad-128-mp3";

  /** A `MediaError` as the element hands one over. Only `code` is read: the
      `message` is empty on every browser measured and vendor-flavoured where it
      is not, so it is never shown. */
  const mediaError = (code: number): MediaError => ({ code, message: "" }) as MediaError;

  afterEach(() => {
    clearPlaybackFailure();
  });

  it("starts with no failure", () => {
    expect(playbackFailure()).toBeNull();
  });

  // The four the spec defines, as a table — a `switch` that answered the same
  // reason twice would still pass a single-code test.
  it.each([
    [1, "aborted"],
    [2, "network"],
    [3, "decode"],
    [4, "unsupported"],
  ] as ReadonlyArray<readonly [number, AudioFailure]>)(
    "records MediaError code %i as %s",
    (code, reason) => {
      reportPlaybackFailure(mediaError(code));
      expect(playbackFailure()).toBe(reason);
    },
  );

  it("records a code outside the spec's four as unknown rather than dropping it", () => {
    // A failure we cannot NAME is still a failure, and the surface must say
    // something. Silently ignoring an unrecognised code is how a bar goes back
    // to looking like a paused station.
    reportPlaybackFailure(mediaError(9));
    expect(playbackFailure()).toBe("unknown");
  });

  it("records a failure even when the element supplies no MediaError", () => {
    // `error` is typed `MediaError | null`, and the event having fired is
    // itself the fact. Same argument as the unknown code above.
    reportPlaybackFailure(null);
    expect(playbackFailure()).toBe("unknown");
  });

  it("every reason has a sentence for the operator", () => {
    const reasons: readonly AudioFailure[] = [
      "aborted",
      "network",
      "decode",
      "unsupported",
      "unknown",
    ];
    const said = reasons.map((r) => audioFailureLabel(r));
    expect(said.every((s) => s.length > 0)).toBe(true);
    // Distinct, because the operator's next move differs: a lost connection is
    // worth re-pressing play for and an unplayable source never will be.
    expect(new Set(said).size).toBe(reasons.length);
  });

  it("tuning a new source clears the previous one's failure", () => {
    playAudio(STATION, "Groove Salad");
    reportPlaybackFailure(mediaError(4));

    playAudio("https://grappa.example/uploads/abc", null);

    expect(playbackFailure()).toBeNull();
  });

  it("closing the player leaves no stale failure behind", () => {
    playAudio(STATION, "Groove Salad");
    reportPlaybackFailure(mediaError(2));

    closeAudio();

    expect(playbackFailure()).toBeNull();
  });

  it("clearPlaybackFailure re-arms the notice for a retry of the SAME source", () => {
    // The retry door. Without it a second failure of the same source would
    // change no signal, so the operator would press play and watch nothing
    // happen — the bar would look frozen rather than re-refused.
    playAudio(STATION, "Groove Salad");
    reportPlaybackFailure(mediaError(2));

    clearPlaybackFailure();

    expect(playbackFailure()).toBeNull();
    expect(activeAudio()).not.toBeNull();
  });

  it("token rotation clears it with the rest of the store (identity-scoped)", () => {
    setToken("tokA");
    playAudio(STATION, "Groove Salad");
    reportPlaybackFailure(mediaError(3));

    setToken("tokB");

    expect(playbackFailure()).toBeNull();
    expect(activeAudio()).toBeNull();
  });

  // THE load-bearing assertion, third time on this edge, and `toBe` for the
  // same reason #1697 spells out: only a source object whose IDENTITY survives
  // the write leaves the element's effect asleep. A `failure` field inside
  // `AudioPlayerState` fails exactly here.
  it("reporting a failure does not touch the source object — same reference in, same out", () => {
    playAudio(STATION, "Groove Salad");
    const before = activeAudio();

    reportPlaybackFailure(mediaError(4));

    expect(activeAudio()).toBe(before);
  });
});
