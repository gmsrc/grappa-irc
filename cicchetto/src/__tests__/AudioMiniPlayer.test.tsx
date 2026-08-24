import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AudioMiniPlayer from "../AudioMiniPlayer";
import { activeAudio, closeAudio, playAudio, playerHidden, showPlayer } from "../lib/audioPlayer";
import type { RadioStation } from "../lib/radioStations";

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
  showPlayer();
});

afterEach(() => {
  closeAudio();
  showPlayer();
  vi.restoreAllMocks();
  // #1698 — `restoreAllMocks` does NOT undo `stubGlobal`, so without this the
  // feed stub the track tests install would outlive them and sit under every
  // later test in the file. Same pairing `RailRadio.test.tsx` already uses.
  vi.unstubAllGlobals();
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

  // #1697 — the bar was permanent once a station was tuned: the only way off
  // the screen was the ✕, which STOPS. Hiding is a different gesture and the
  // two must not be one control.
  //
  // Why these assertions and not a screenshot: jsdom implements no media
  // pipeline, so "it kept playing" is not directly observable here. What IS
  // observable — and is the entire mechanism — is that the <audio> element
  // survives the gesture with its source attached and that neither `pause()`
  // nor a fresh `play()` is issued. Those three together are exactly the
  // footprint of "nothing in the element's effect chain ran".
  describe("#1697 — hiding the surface without stopping the audio", () => {
    const STATION = "https://ice.somafm.com/groovesalad-128-mp3";

    it("hiding removes the bar but leaves the source loaded and untouched", () => {
      render(() => <AudioMiniPlayer />);
      playAudio(STATION, "Groove Salad");
      playSpy.mockClear();
      pauseSpy.mockClear();

      screen.getByTestId("audio-mini-player-hide").click();

      expect(screen.queryByTestId("audio-mini-player")).toBeNull();
      expect(screen.getByTestId("audio-mini-player-el")).toHaveAttribute("src", STATION);
      expect(activeAudio()).not.toBeNull();
      expect(playerHidden()).toBe(true);
    });

    it("hiding issues no pause and no re-play — the element is not disturbed", () => {
      // The mutation this kills: reaching for `activeAudio` to carry the hidden
      // flag. That re-fires `on(activeAudio)`, which reassigns `audioEl.src`
      // and calls `play()` again — a visible re-buffer of a live stream, which
      // is precisely the thing "hide ≠ stop" forbids.
      render(() => <AudioMiniPlayer />);
      playAudio(STATION, "Groove Salad");
      playSpy.mockClear();
      pauseSpy.mockClear();

      screen.getByTestId("audio-mini-player-hide").click();

      expect(pauseSpy).not.toHaveBeenCalled();
      expect(playSpy).not.toHaveBeenCalled();
    });

    it("the bar comes back with the same source still attached", () => {
      render(() => <AudioMiniPlayer />);
      playAudio(STATION, "Groove Salad");
      screen.getByTestId("audio-mini-player-hide").click();
      playSpy.mockClear();

      showPlayer();

      expect(screen.getByTestId("audio-mini-player")).toBeInTheDocument();
      expect(screen.getByTestId("audio-mini-player-el")).toHaveAttribute("src", STATION);
      expect(playSpy).not.toHaveBeenCalled();
    });

    it("hide and close stay two distinct controls, and only close stops", () => {
      // Guards against the tempting simplification of folding them: the ✕ is
      // the STOP verb (#115) and the phone's only reachable one while the rail
      // is slid off-screen.
      render(() => <AudioMiniPlayer />);
      playAudio(STATION, "Groove Salad");

      expect(screen.getByTestId("audio-mini-player-hide")).toBeInTheDocument();
      screen.getByTestId("audio-mini-player-close").click();

      expect(activeAudio()).toBeNull();
      expect(pauseSpy).toHaveBeenCalled();
    });

    it("a new source re-shows a hidden bar rather than playing behind it", () => {
      render(() => <AudioMiniPlayer />);
      playAudio(STATION, "Groove Salad");
      screen.getByTestId("audio-mini-player-hide").click();

      playAudio("https://grappa.example/uploads/abc", null);

      expect(screen.getByTestId("audio-mini-player")).toBeInTheDocument();
    });
  });

  // #1698 — the track, on the one surface a phone can see.
  //
  // The SAME argument the label above is defended with, applied one field
  // further: `.shell-members` is `translateX(100%)` on mobile, so the rail's
  // chrome is off-screen while the station plays and this bar is the only
  // place the track can appear at all. Rail-only would have meant the phone —
  // where a radio is most used — never learns what is on.
  describe("the now-playing track (#1698)", () => {
    const TRACK = "Trestal — A Land Unknown";

    /** Render the bar, tune the first curated station against a stubbed feed
        and wait for the track to reach the row. Returns the station, so a
        caller can assert against the title the table actually carries rather
        than a copy of it. */
    const tuneWithFeed = async (): Promise<RadioStation> => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ songs: [{ title: "A Land Unknown", artist: "Trestal" }] }),
        } as unknown as Response),
      );
      const { tuneStation } = await import("../lib/radio");
      const { RADIO_STATIONS } = await import("../lib/radioStations");
      const station = RADIO_STATIONS[0];
      if (station === undefined) throw new Error("the curated table must carry a station");

      render(() => <AudioMiniPlayer />);
      tuneStation(station);

      await vi.waitFor(() =>
        expect(screen.getByTestId("audio-mini-player-track")).toBeInTheDocument(),
      );
      return station;
    };

    it("names the track next to the station once the feed has answered", async () => {
      const station = await tuneWithFeed();

      expect(screen.getByTestId("audio-mini-player-track")).toHaveTextContent(TRACK);
      // Both, not one: the station answers "what am I listening to" and the
      // track answers "what is on". Collapsing them would cost the phone the
      // station name, which is the #682 reason this label exists.
      expect(screen.getByTestId("audio-mini-player-label")).toHaveTextContent(station.title);
    });

    it("shows no track slot for an audio upload", () => {
      // An upload is not a station and has no feed. The slot must be absent
      // rather than empty — an empty span still takes its gap.
      render(() => <AudioMiniPlayer />);
      playAudio("https://grappa.example/uploads/abc", null);

      expect(screen.queryByTestId("audio-mini-player-track")).toBeNull();
    });

    // Where the two slices meet, and the one case neither of them owns alone.
    //
    // #1697 gave the transport a HIDDEN state; #1698 put a live fact on that
    // transport. The chrome half needs no code: the span sits inside the same
    // <Show> the hide predicate narrows, so a hidden bar cannot render a track
    // — showing one on a surface that is not there would be nothing at all.
    //
    // The half that DOES need stating is the other one. `/np` is a COMMAND, not
    // chrome, and an operator who hid the bar to get their screen back is
    // exactly the operator who then asks the channel what is on. So the fact
    // must outlive the surface — which it does because the poll is keyed on
    // `tunedStation()`, i.e. on the AUDIO, and hiding deliberately says nothing
    // about the audio. Keying it on visibility instead would have made `/np`
    // answer "nothing is playing" in the state a phone spends most of its time
    // in, and that refusal would have been a lie rather than a report.
    it("hiding the bar takes the track off screen without taking it from /np", async () => {
      const station = await tuneWithFeed();
      const { nowPlayingLabel } = await import("../lib/nowPlaying");
      const { tunedStation } = await import("../lib/radio");

      screen.getByTestId("audio-mini-player-hide").click();

      expect(screen.queryByTestId("audio-mini-player-track")).toBeNull();
      expect(nowPlayingLabel()).toBe(TRACK);
      // The mechanism, not a proxy for it: routing the hidden flag through
      // `activeAudio` — the shape #1697's own comment forbids — would null this
      // out, and the poll keyed on it would stop with the chrome.
      expect(tunedStation()).toBe(station);
    });
  });
});
