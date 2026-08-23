import { afterEach, describe, expect, it } from "vitest";
import { activeAudio, closeAudio, playAudio } from "../lib/audioPlayer";
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
