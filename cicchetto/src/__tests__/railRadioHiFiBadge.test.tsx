import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAudio } from "../lib/audioPlayer";
import { closeRadioPicker, openRadioPicker } from "../lib/radio";
import { RADIO_STATIONS } from "../lib/radioStations";
import RailRadio, { HI_FI_BADGE } from "../RailRadio";

// #1836 — the `[hi-fi]` badge (vjt's ruling), and the one property the REAL
// table cannot yet demonstrate.
//
// WHY THIS FILE MOCKS THE TABLE, when its sibling `RailRadio.test.tsx` states
// in its own header that the table is used for real. The badge is a
// PRECONDITION for the FLAC stations, not a follow-up: it is what makes those
// rows safe to offer to somebody on a metered connection, so it ships BEFORE
// them and no row in the curated table is lossless today. A test written
// against the real table could therefore only assert that nothing draws the
// badge — which passes just as happily against a component that cannot draw it
// at all, i.e. a mirror of the bug rather than a test of the feature.
//
// So the fixtures below are the real rows with their FORMAT overridden, and
// nothing else: real ids, so `RADIO_LOGO_PATHS` still resolves and the render
// path is the production one end to end; only the two fields under test move.
// The lossy and null-bitrate arms are here rather than in the sibling for the
// same reason the positive one is — all three cases side by side, over rows
// this file controls, is what makes the badge's ABSENCE evidence instead of a
// coincidence of today's table.
vi.mock("../lib/radioStations", async (importActual) => {
  const actual = await importActual<typeof import("../lib/radioStations")>();
  const [first, second, third] = actual.RADIO_STATIONS;
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error("the curated table must carry at least three stations for these fixtures");
  }
  // Typed off the real row rather than cast: a fixture the type would reject
  // is a fixture the table could never hold, and a `as` here would let the
  // codec drift to a free string — the exact thing the closed set exists to
  // stop.
  const reformat = (
    station: typeof first,
    codec: (typeof first)["codec"],
    bitrate: number | null,
  ): typeof first => ({ ...station, codec, bitrate });
  return {
    ...actual,
    RADIO_STATIONS: [
      reformat(first, "flac", 1411),
      reformat(second, "mp3", 128),
      reformat(third, "vorbis", null),
    ],
  };
});

const [lossless, lossy, unpriced] = RADIO_STATIONS;
if (lossless === undefined || lossy === undefined || unpriced === undefined) {
  throw new Error("the mocked table must carry the three fixtures");
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

describe("the picker's hi-fi badge (#1836)", () => {
  it("marks a lossless row, so a metered listener sees the cost before pressing play", () => {
    render(() => <RailRadio />);
    openRadioPicker();

    expect(screen.getByTestId(`rail-radio-station-hifi-${lossless.id}`)).toHaveTextContent(
      HI_FI_BADGE,
    );
  });

  it("leaves a lossy row unmarked — a badge on everything marks nothing", () => {
    render(() => <RailRadio />);
    openRadioPicker();

    expect(screen.queryByTestId(`rail-radio-station-hifi-${lossy.id}`)).toBeNull();
    // And the row is still priced: the absent badge must be the CODEC's doing,
    // not the whole format line failing to render.
    expect(screen.getByTestId(`rail-radio-station-format-${lossy.id}`)).toHaveTextContent(
      "mp3 128k",
    );
  });

  it("draws no number for a station whose provider declares no bitrate", () => {
    // #1696's defect in the shape this field invites: rendering the absence as
    // "null" or "0k" is a fact the row does not have, dressed as one it does.
    // The codec still shows — that much IS known.
    render(() => <RailRadio />);
    openRadioPicker();

    const format = screen.getByTestId(`rail-radio-station-format-${unpriced.id}`);
    expect(format).toHaveTextContent("vorbis");
    expect(format.textContent ?? "", "an unpriced row rendered a number").not.toMatch(/\d/);
    expect(format.textContent ?? "", "an unpriced row rendered its own nullness").not.toMatch(
      /null|undefined|NaN/,
    );
  });

  it("keeps the badge off the row whose bitrate is merely unknown", () => {
    // The two nullable-shaped facts are independent: "we do not know the
    // bitrate" is not "this is lossless", and a badge keyed on the missing
    // number instead of the codec would say it is.
    render(() => <RailRadio />);
    openRadioPicker();

    expect(screen.getByTestId(`rail-radio-station-${unpriced.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`rail-radio-station-hifi-${unpriced.id}`)).toBeNull();
  });
});
