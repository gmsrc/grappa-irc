import { afterEach, describe, expect, it } from "vitest";
import { activeAudio, closeAudio, playAudio } from "../lib/audioPlayer";
import { setToken } from "../lib/auth";
import {
  closeRadioPicker,
  radioPickerOpen,
  toggleRadioPicker,
  tunedStation,
  tuneStation,
} from "../lib/radio";
import { RADIO_STATIONS } from "../lib/radioStations";

// #682 — the radio store. It owns exactly ONE piece of state (is the picker
// open) and DERIVES the rest, which is the whole point of these tests: the
// tuned station is read back out of the single `audioPlayer` store rather
// than tracked alongside it, so the two cannot disagree.

const station = RADIO_STATIONS[0];
const other = RADIO_STATIONS[1];
if (station === undefined || other === undefined) {
  throw new Error("the curated table must carry at least two stations for these tests");
}

afterEach(() => {
  closeAudio();
  closeRadioPicker();
  setToken(null);
});

describe("radio store", () => {
  it("starts with nothing tuned and the picker shut", () => {
    expect(tunedStation()).toBeNull();
    expect(radioPickerOpen()).toBe(false);
  });

  it("tuning hands the stream and the station name to the one audio player", () => {
    tuneStation(station);
    expect(activeAudio()).toEqual({ href: station.streamUrl, label: station.title });
  });

  it("reads the tuned station back off the player", () => {
    tuneStation(station);
    expect(tunedStation()).toEqual(station);
  });

  it("tuning a second station swaps the first — one player, not two", () => {
    tuneStation(station);
    tuneStation(other);
    expect(tunedStation()).toEqual(other);
    expect(activeAudio()?.href).toBe(other.streamUrl);
  });

  it("an audio upload taking over the player un-tunes the station", () => {
    // The load-bearing case for DERIVING rather than storing. There is one
    // <audio> element, so a clicked audio link swaps the source out from
    // under the station. A stored `tuned` signal would keep claiming the
    // station is playing while the upload plays; a derived one cannot.
    tuneStation(station);
    playAudio("https://grappa.example/uploads/abc", null);
    expect(tunedStation()).toBeNull();
  });

  it("closing the player un-tunes the station", () => {
    tuneStation(station);
    closeAudio();
    expect(tunedStation()).toBeNull();
  });

  it("toggles the picker open and shut", () => {
    toggleRadioPicker();
    expect(radioPickerOpen()).toBe(true);
    toggleRadioPicker();
    expect(radioPickerOpen()).toBe(false);
  });

  it("keeps the picker open after tuning, so stations can be auditioned", () => {
    // Follows the rule RailActions already states for `denoise`: a launcher
    // that NAVIGATES away closes the menu, a control the operator flips in
    // place and re-flips does not. Tuning is the second kind.
    toggleRadioPicker();
    tuneStation(station);
    expect(radioPickerOpen()).toBe(true);
  });

  it("token rotation shuts the picker (identity-scoped)", () => {
    setToken("tokA");
    toggleRadioPicker();
    expect(radioPickerOpen()).toBe(true);

    setToken("tokB");
    expect(radioPickerOpen()).toBe(false);
  });

  it("token rotation un-tunes, because it stops the player it derives from", () => {
    setToken("tokA");
    tuneStation(station);
    expect(tunedStation()).not.toBeNull();

    setToken("tokB");
    expect(tunedStation()).toBeNull();
  });
});
