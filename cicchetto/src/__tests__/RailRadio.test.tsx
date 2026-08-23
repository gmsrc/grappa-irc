import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeAudio, closeAudio, playAudio } from "../lib/audioPlayer";
import { closeRadioPicker, openRadioPicker, radioPickerOpen } from "../lib/radio";
import { RADIO_STATIONS } from "../lib/radioStations";
import RailRadio from "../RailRadio";

// #682 — the rail's radio surface. Two views of the ONE audio player: a
// station picker and, once something is tuned, the station chrome. The
// transport itself stays docked above compose (AudioMiniPlayer) — see the
// component header for why the rail cannot host it.
//
// The store and the station table are used FOR REAL here (both are pure, and
// mocking them would leave the wiring these tests exist to check untested);
// only the media element is stubbed, since jsdom implements no playback.

const station = RADIO_STATIONS[0];
const other = RADIO_STATIONS[1];
if (station === undefined || other === undefined) {
  throw new Error("the curated table must carry at least two stations for these tests");
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  closeAudio();
  closeRadioPicker();
});

afterEach(() => {
  closeAudio();
  closeRadioPicker();
  vi.restoreAllMocks();
});

describe("RailRadio", () => {
  it("costs the rail nothing while idle — no chrome, no picker", () => {
    // #500's budget: a permanently-expanded panel above RailActions re-charges
    // the vertical cost that issue paid to remove. Nothing tuned and the
    // picker shut must render neither.
    render(() => <RailRadio />);
    expect(screen.queryByTestId("rail-radio-picker")).toBeNull();
    expect(screen.queryByTestId("rail-radio-now")).toBeNull();
  });

  it("lists every curated station when the picker is open", () => {
    render(() => <RailRadio />);
    openRadioPicker();

    expect(screen.getByTestId("rail-radio-picker")).toBeInTheDocument();
    for (const s of RADIO_STATIONS) {
      expect(
        screen.getByTestId(`rail-radio-station-${s.id}`),
        `station ${s.id} missing from the picker`,
      ).toBeInTheDocument();
    }
  });

  it("picking a station hands its stream and title to the one player", () => {
    render(() => <RailRadio />);
    openRadioPicker();

    screen.getByTestId(`rail-radio-station-${station.id}`).click();

    expect(activeAudio()).toEqual({ href: station.streamUrl, label: station.title });
  });

  it("shows the station chrome once something is tuned", () => {
    render(() => <RailRadio />);
    openRadioPicker();
    screen.getByTestId(`rail-radio-station-${station.id}`).click();

    expect(screen.getByTestId("rail-radio-now")).toHaveTextContent(station.title);
  });

  it("marks which station is playing, so the picker is not a blind list", () => {
    render(() => <RailRadio />);
    openRadioPicker();
    screen.getByTestId(`rail-radio-station-${station.id}`).click();

    expect(screen.getByTestId(`rail-radio-station-${station.id}`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId(`rail-radio-station-${other.id}`)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("stops playback from the rail chrome", () => {
    render(() => <RailRadio />);
    openRadioPicker();
    screen.getByTestId(`rail-radio-station-${station.id}`).click();

    screen.getByTestId("rail-radio-stop").click();

    expect(activeAudio()).toBeNull();
    expect(screen.queryByTestId("rail-radio-now")).toBeNull();
  });

  it("drops the chrome when an audio upload takes the player over", () => {
    // One <audio>: a clicked audio link swaps the source out from under the
    // station. The rail must stop claiming a station is playing — this is the
    // derived-not-stored contract, seen from the UI.
    render(() => <RailRadio />);
    openRadioPicker();
    screen.getByTestId(`rail-radio-station-${station.id}`).click();
    expect(screen.getByTestId("rail-radio-now")).toBeInTheDocument();

    playAudio("https://grappa.example/uploads/abc", null);

    expect(screen.queryByTestId("rail-radio-now")).toBeNull();
  });

  it("keeps the picker open after a pick, so stations can be auditioned", () => {
    render(() => <RailRadio />);
    openRadioPicker();
    screen.getByTestId(`rail-radio-station-${station.id}`).click();

    expect(screen.getByTestId("rail-radio-picker")).toBeInTheDocument();
  });

  it("closes the picker from its own dismiss control", () => {
    render(() => <RailRadio />);
    openRadioPicker();

    screen.getByTestId("rail-radio-picker-close").click();

    expect(screen.queryByTestId("rail-radio-picker")).toBeNull();
    expect(radioPickerOpen()).toBe(false);
  });

  it("an outside pointerdown closes the picker without tuning anything", () => {
    // Wiring check for the shared dismiss verb: the click still reaches its
    // target (non-blocking listener, not a scrim), so a tap on a sidebar
    // channel selects it in one gesture.
    render(() => <RailRadio />);
    openRadioPicker();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId("rail-radio-picker")).toBeNull();
    expect(activeAudio()).toBeNull();
  });

  it("a pointerdown inside the picker does not dismiss it", () => {
    render(() => <RailRadio />);
    openRadioPicker();

    fireEvent.pointerDown(screen.getByTestId(`rail-radio-station-${station.id}`));

    expect(screen.getByTestId("rail-radio-picker")).toBeInTheDocument();
  });
});
