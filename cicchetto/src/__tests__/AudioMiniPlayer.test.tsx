import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AudioMiniPlayer from "../AudioMiniPlayer";
import { activeAudio, closeAudio, playAudio } from "../lib/audioPlayer";

// jsdom does not implement HTMLMediaElement playback — stub the methods
// the player drives so the component mounts without "Not implemented".
// Real playback is e2e/device territory (Playwright + iPhone dogfood);
// these tests pin the bar's show/hide + control wiring only.
let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  playSpy = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(() => Promise.resolve());
  pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  closeAudio();
});

afterEach(() => {
  closeAudio();
  vi.restoreAllMocks();
});

describe("AudioMiniPlayer", () => {
  it("renders no bar when no audio is active", () => {
    render(() => <AudioMiniPlayer />);
    expect(screen.queryByTestId("audio-mini-player")).toBeNull();
  });

  it("shows the bar and starts playback when an audio link is played", () => {
    render(() => <AudioMiniPlayer />);
    playAudio("https://grappa.example/uploads/abc", null);

    expect(screen.getByTestId("audio-mini-player")).toBeInTheDocument();
    expect(playSpy).toHaveBeenCalled();
  });

  it("close button stops playback and hides the bar", () => {
    render(() => <AudioMiniPlayer />);
    playAudio("https://grappa.example/uploads/abc", null);

    screen.getByTestId("audio-mini-player-close").click();

    expect(pauseSpy).toHaveBeenCalled();
    expect(screen.queryByTestId("audio-mini-player")).toBeNull();
    expect(activeAudio()).toBeNull();
  });

  it("renders the transport controls (toggle, seek, time)", () => {
    // Structure only — actual play/pause + seek behavior depends on
    // real media state jsdom does not implement; that is pinned by the
    // Playwright e2e + iPhone dogfood, not here.
    render(() => <AudioMiniPlayer />);
    playAudio("https://grappa.example/uploads/abc", null);

    expect(screen.getByTestId("audio-mini-player-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("audio-mini-player-seek")).toBeInTheDocument();
    expect(screen.getByTestId("audio-mini-player-time")).toBeInTheDocument();
  });

  it("download link points at the active href with the download attribute", () => {
    // Same-origin `download` anchor: forces a save (overriding the
    // server's `inline` disposition) and inherits the server's
    // Content-Disposition filename — no value needed.
    render(() => <AudioMiniPlayer />);
    playAudio("https://grappa.example/uploads/abc", null);

    const dl = screen.getByTestId("audio-mini-player-download");
    expect(dl).toHaveAttribute("href", "https://grappa.example/uploads/abc");
    expect(dl).toHaveAttribute("download");
  });

  // #682 — LIVE mode. The transport was written for a FILE: it renders a
  // position slider and a "cur / dur" read, both meaningless against an
  // endless Icecast stream. The mode is DERIVED from the element's own
  // `duration` (non-finite ⇒ nothing to scrub within), not from a flag the
  // caller sets — so it is right for ANY endless source, not just the radio
  // stations that motivated it, and cannot drift from the element's truth.
  //
  // jsdom implements no media pipeline, so `duration` is stubbed on the
  // INSTANCE and the metadata event replayed by hand — the same seam the
  // play/pause spies above use, at the one property the mode reads.
  const loadMetadataWithDuration = (duration: number): void => {
    const el = screen.getByTestId("audio-mini-player-el");
    Object.defineProperty(el, "duration", { configurable: true, value: duration });
    el.dispatchEvent(new Event("loadedmetadata"));
  };

  it("a finite duration keeps the seek control and the download link", () => {
    render(() => <AudioMiniPlayer />);
    playAudio("https://grappa.example/uploads/abc", null);

    loadMetadataWithDuration(212);

    expect(screen.getByTestId("audio-mini-player-seek")).toBeInTheDocument();
    expect(screen.getByTestId("audio-mini-player-download")).toBeInTheDocument();
    expect(screen.queryByTestId("audio-mini-player-live")).toBeNull();
  });

  it("an endless stream drops the seek control — there is nothing to scrub", () => {
    render(() => <AudioMiniPlayer />);
    playAudio("https://ice.somafm.com/groovesalad-128-mp3", "Groove Salad");

    loadMetadataWithDuration(Number.POSITIVE_INFINITY);

    expect(screen.queryByTestId("audio-mini-player-seek")).toBeNull();
    expect(screen.getByTestId("audio-mini-player-live")).toBeInTheDocument();
  });

  it("an endless stream drops the download link — a save that never completes", () => {
    // Two independent reasons, either one sufficient: the resource has no
    // end, so the save never finishes; and `download` is ignored outright on
    // a cross-origin href, so the anchor would navigate away from the app.
    render(() => <AudioMiniPlayer />);
    playAudio("https://ice.somafm.com/groovesalad-128-mp3", "Groove Salad");

    loadMetadataWithDuration(Number.POSITIVE_INFINITY);

    expect(screen.queryByTestId("audio-mini-player-download")).toBeNull();
  });

  it("an unknown (NaN) duration is treated as live, not as a zero-length file", () => {
    // `duration` is NaN whenever the element cannot state a length. Seeking
    // is exactly as meaningless there as against Infinity, so the predicate
    // is "not a finite number" rather than "=== Infinity".
    render(() => <AudioMiniPlayer />);
    playAudio("https://ice.somafm.com/dronezone-128-mp3", "Drone Zone");

    loadMetadataWithDuration(Number.NaN);

    expect(screen.queryByTestId("audio-mini-player-seek")).toBeNull();
    expect(screen.getByTestId("audio-mini-player-live")).toBeInTheDocument();
  });

  it("shows the source label when one was supplied", () => {
    // On mobile the right rail is a drawer slid off-screen
    // (`transform: translateX(100%)`), so while a station plays this docked
    // bar is the ONLY thing on screen naming it. Without the label the phone
    // cannot answer "what am I listening to".
    render(() => <AudioMiniPlayer />);
    playAudio("https://ice.somafm.com/groovesalad-128-mp3", "Groove Salad");

    expect(screen.getByTestId("audio-mini-player-label")).toHaveTextContent("Groove Salad");
  });

  it("renders no label slot for an unlabelled source", () => {
    render(() => <AudioMiniPlayer />);
    playAudio("https://grappa.example/uploads/abc", null);

    expect(screen.queryByTestId("audio-mini-player-label")).toBeNull();
  });
});
