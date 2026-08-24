import { afterEach, describe, expect, it } from "vitest";
import {
  activeAudio,
  closeAudio,
  hidePlayer,
  playAudio,
  playerHidden,
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
