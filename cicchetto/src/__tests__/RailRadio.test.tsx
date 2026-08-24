import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeAudio,
  audioFailureLabel,
  clearPlaybackFailure,
  closeAudio,
  hidePlayer,
  playAudio,
  playerHidden,
  reportPlaybackFailure,
} from "../lib/audioPlayer";
import { closeRadioPicker, openRadioPicker, radioPickerOpen } from "../lib/radio";
import { radioLogoPlaceholder } from "../lib/radioLogoPlaceholder";
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

/** One 200 carrying a `…/songs/<id>.json` body. */
const songsOk = (title: string, artist: string): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ songs: [{ title, artist }] }),
  }) as unknown as Response;

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  // #1698 — MANDATORY, not decoration. This component now reads `nowPlaying`,
  // whose poll fires on every tune. Unstubbed, each test that clicks a station
  // would make a real cross-origin request to api.somafm.com from the worker —
  // a unit gate quietly depending on a third party's uptime. Same hazard the
  // `InertWebSocket` in setupTests exists for, one module over.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(songsOk("A Land Unknown", "Trestal")));
  closeAudio();
  closeRadioPicker();
});

afterEach(() => {
  closeAudio();
  closeRadioPicker();
  clearPlaybackFailure();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  // #1737 — the band is what says "this is playing", so tapping it is the
  // obvious way back to a transport the operator hid (#1697). The
  // `rail-action-show-player` drawer entry stays: it is the GENERAL door,
  // because an upload carries `label: null`, is in no station table, and
  // renders no band at all.
  describe("tap to restore a hidden player (#1737)", () => {
    it("restores the transport when the band is tapped", () => {
      render(() => <RailRadio />);
      openRadioPicker();
      screen.getByTestId(`rail-radio-station-${station.id}`).click();
      hidePlayer();
      expect(playerHidden()).toBe(true);

      screen.getByTestId("rail-radio-now-restore").click();

      expect(playerHidden()).toBe(false);
      // Restoring the CHROME must not touch the SOURCE — the two axes the
      // store keeps in separate signals for exactly this reason.
      expect(activeAudio()?.href).toBe(station.streamUrl);
    });

    it("names the station it would bring back", () => {
      // Hidden, this control inherits the job the docked bar's caption did:
      // answering "what am I listening to". Same posture as the drawer entry.
      render(() => <RailRadio />);
      openRadioPicker();
      screen.getByTestId(`rail-radio-station-${station.id}`).click();

      expect(screen.getByTestId("rail-radio-now-restore")).toHaveAccessibleName(
        `show player — ${station.title}`,
      );
    });

    it("leaves ⏹ its own tap target: stopping from a hidden player still stops", () => {
      // The issue's explicit constraint. Observable half: the restore control
      // must not SWALLOW the stop click.
      render(() => <RailRadio />);
      openRadioPicker();
      screen.getByTestId(`rail-radio-station-${station.id}`).click();
      hidePlayer();

      screen.getByTestId("rail-radio-stop").click();

      expect(activeAudio()).toBeNull();
      expect(screen.queryByTestId("rail-radio-now")).toBeNull();
    });

    it("keeps ⏹ OUTSIDE the restore control, so stop cannot become restore-then-stop", () => {
      // The other half of that constraint, and it can only be expressed
      // structurally: `closeAudio` resets `playerHidden` to false itself, so
      // "stopped" and "restored then stopped" are the SAME observable state.
      // Nesting is what would make the row handler fire on a ⏹ tap, so the
      // guarantee is that the two controls are siblings — no `stopPropagation`
      // ordering rule for a future reader to get wrong.
      render(() => <RailRadio />);
      openRadioPicker();
      screen.getByTestId(`rail-radio-station-${station.id}`).click();

      const restore = screen.getByTestId("rail-radio-now-restore");
      const stop = screen.getByTestId("rail-radio-stop");

      expect(restore.contains(stop)).toBe(false);
      // Both are real buttons: a nested <button> is invalid HTML, which is
      // why the identity half — and not the whole row — is the control.
      expect(restore.tagName).toBe("BUTTON");
      expect(stop.tagName).toBe("BUTTON");
    });
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

  // #1697 — the picker had rebuilt the band `PaneTopBar` already provides, on
  // its own `--rail-radio-*` layer, free to drift from the two surfaces that
  // render the real one. #1073 extracted that band for exactly this reason;
  // the picker is its third host.
  describe("#1697 — the picker hosts the shared pane band", () => {
    const band = (container: HTMLElement): Element | null =>
      container.querySelector(".rail-radio-picker .topic-bar");

    it("renders the shared band, not a lookalike of it", () => {
      const { container } = render(() => <RailRadio />);
      openRadioPicker();

      expect(band(container)).not.toBeNull();
      expect(container.querySelector(".rail-radio-picker-head")).toBeNull();
    });

    it("puts its heading in the band's content slot", () => {
      const { container } = render(() => <RailRadio />);
      openRadioPicker();

      const slot = container.querySelector(".rail-radio-picker .topic-bar-header");
      expect(slot).toHaveTextContent("radio");
    });

    it("puts the ✕ LAST in the band, where the other two hosts put their ☰", () => {
      // #1073's ordering rule, inherited: the trailing child is what places the
      // control on the right, on every surface that wears this band.
      const { container } = render(() => <RailRadio />);
      openRadioPicker();

      expect(band(container)?.lastElementChild).toBe(screen.getByTestId("rail-radio-picker-close"));
    });

    it("the ✕ wears the shared chrome button, which is what gives it a tap target", () => {
      // The hit-target half of item 3. `.shell-chrome-btn` carries
      // `min-width/height: var(--chrome-tap-min)` (48px ABSOLUTE); the bespoke
      // rule it replaces asked for 2rem, which is 28px at this app's 14px root.
      render(() => <RailRadio />);
      openRadioPicker();

      expect(screen.getByTestId("rail-radio-picker-close")).toHaveClass("shell-chrome-btn");
    });

    it("the rail's stop control wears it too — the same defect, twice", () => {
      render(() => <RailRadio />);
      openRadioPicker();
      screen.getByTestId(`rail-radio-station-${station.id}`).click();

      expect(screen.getByTestId("rail-radio-stop")).toHaveClass("shell-chrome-btn");
    });

    it("keeps the accessible name and the dismiss wiring across the move", () => {
      render(() => <RailRadio />);
      openRadioPicker();

      const close = screen.getByTestId("rail-radio-picker-close");
      expect(close).toHaveAttribute("aria-label", "close radio picker");
      close.click();

      expect(radioPickerOpen()).toBe(false);
    });

    it("does not offer a rail opener inside the already-open rail", () => {
      // The band's other two hosts put a ☰ in the trailing slot. Rendering one
      // HERE would be a door to the surface it is already standing on — and on
      // desktop it is `display: none`, so the picker would lose its only
      // dismiss control to a CSS rule written for a different host.
      const { container } = render(() => <RailRadio />);
      openRadioPicker();

      expect(container.querySelector(".rail-radio-picker .topic-bar-hamburger")).toBeNull();
      expect(
        container.querySelector(".rail-radio-picker [data-testid='shell-chrome-rail-opener']"),
      ).toBeNull();
    });
  });

  // #1698 — the chrome answers "what is playing" and now says it twice: which
  // STATION, and which TRACK.
  it("names the track once the feed has answered", async () => {
    render(() => <RailRadio />);
    openRadioPicker();
    screen.getByTestId(`rail-radio-station-${station.id}`).click();
    await vi.waitFor(() => expect(screen.getByTestId("rail-radio-now-track")).toBeInTheDocument());

    expect(screen.getByTestId("rail-radio-now-track")).toHaveTextContent(
      "Trestal — A Land Unknown",
    );
    // The station name stays: the track is the second fact, not a replacement
    // for the first.
    expect(screen.getByTestId("rail-radio-now-title")).toHaveTextContent(station.title);
  });

  it("shows the genres while no track is known, and swaps them for the track", async () => {
    // Same SLOT, not a third line. #500 bought the rail's vertical budget by
    // collapsing the actions behind one launcher, and a permanently taller
    // chrome would re-charge part of that. Nothing is lost: the genres are
    // still on every picker row, which is where browsing by genre happens.
    render(() => <RailRadio />);
    openRadioPicker();
    screen.getByTestId(`rail-radio-station-${station.id}`).click();

    expect(screen.getByTestId("rail-radio-now-genres")).toBeInTheDocument();

    await vi.waitFor(() => expect(screen.getByTestId("rail-radio-now-track")).toBeInTheDocument());
    expect(screen.queryByTestId("rail-radio-now-genres")).toBeNull();
  });

  it("claims no track when the feed refuses to answer", async () => {
    // The honest empty: a station that plays while its feed is down shows the
    // station and says nothing about the track, rather than showing the last
    // one it knew from some other station.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    render(() => <RailRadio />);
    openRadioPicker();
    screen.getByTestId(`rail-radio-station-${station.id}`).click();
    await vi.waitFor(() => expect(screen.getByTestId("rail-radio-now")).toBeInTheDocument());

    expect(screen.queryByTestId("rail-radio-now-track")).toBeNull();
    expect(screen.getByTestId("rail-radio-now-genres")).toBeInTheDocument();
  });

  // #1704 — THE LOGO A STATION DOES NOT HAVE, and the one it has that breaks.
  //
  // Both render sites were a bare `<img>` with no error handling before this,
  // so a 404 drew the browser's broken-image glyph and "no logo" could not be
  // said at all. `logoUrl` is nullable now (Kohina publishes only a favicon),
  // and both cases land on the same stand-in — but they are DIFFERENT facts and
  // both are exercised here: one is declared in the table, the other happens at
  // runtime.
  describe("a station with no logo, and a logo that breaks (#1704)", () => {
    const logoless = RADIO_STATIONS.find((s) => s.logoUrl === null);
    const withLogo = RADIO_STATIONS.find((s) => s.logoUrl !== null);
    if (logoless === undefined || withLogo === undefined) {
      throw new Error("these tests need one station with a logo and one without in the table");
    }

    const rowLogo = (container: HTMLElement, id: string): HTMLImageElement => {
      const img = container.querySelector<HTMLImageElement>(
        `[data-testid="rail-radio-station-${id}"] img`,
      );
      if (img === null) throw new Error(`no logo <img> rendered for station ${id}`);
      return img;
    };

    it("draws our own placeholder for a station that publishes none", () => {
      const { container } = render(() => <RailRadio />);
      openRadioPicker();

      // The production generator, not a copy of its output: a test holding a
      // hand-pasted data URI would pass while the tile silently changed.
      expect(rowLogo(container, logoless.id).getAttribute("src")).toBe(
        radioLogoPlaceholder(logoless.id, logoless.title),
      );
    });

    it("still draws the real logo for a station that has one", () => {
      // The control. Without it, a predicate inverted by one edit would put the
      // placeholder on every row and every other assertion here would pass.
      const { container } = render(() => <RailRadio />);
      openRadioPicker();

      expect(rowLogo(container, withLogo.id).getAttribute("src")).toBe(withLogo.logoUrl);
    });

    it("falls back to the placeholder when a real logo fails to load", () => {
      // The runtime half. `check:radio` gates these URLs, so this can only fire
      // on a transient upstream failure — which is exactly when a tile beats
      // the browser's broken-image glyph.
      const { container } = render(() => <RailRadio />);
      openRadioPicker();
      const img = rowLogo(container, withLogo.id);

      img.dispatchEvent(new Event("error"));

      expect(img.getAttribute("src")).toBe(radioLogoPlaceholder(withLogo.id, withLogo.title));
    });

    it("the rail chrome uses the same stand-in as the picker row", () => {
      // One component behind both sites: the tuned-station chrome and the list
      // row must not disagree about what a station looks like, and before this
      // they were two hand-copied <img> tags free to drift.
      const { container } = render(() => <RailRadio />);
      openRadioPicker();
      screen.getByTestId(`rail-radio-station-${logoless.id}`).click();

      const chrome = container.querySelector<HTMLImageElement>(".rail-radio-now-logo");
      expect(chrome?.getAttribute("src")).toBe(radioLogoPlaceholder(logoless.id, logoless.title));
    });
  });

  // #1744 — the rail's chrome is the DESKTOP answer to "what is playing", and
  // it is also the surface left standing when the operator hides the docked bar
  // (#1697), which takes the transport — and with it #1744's own notice — off
  // the screen while the audio keeps running. A station that cannot play must
  // not sit here wearing its genres as if nothing had happened.
  //
  // Same SLOT as the track and the genres, for #500's reason one line up: the
  // chrome's height must not depend on what the second line happens to say.
  describe("a station that will not play (#1744)", () => {
    it("says so in the second line, in place of the genres", () => {
      render(() => <RailRadio />);
      openRadioPicker();
      screen.getByTestId(`rail-radio-station-${station.id}`).click();
      expect(screen.getByTestId("rail-radio-now-genres")).toBeInTheDocument();

      reportPlaybackFailure({ code: 4, message: "" } as MediaError);

      expect(screen.getByTestId("rail-radio-now-error")).toHaveTextContent(
        audioFailureLabel("unsupported"),
      );
      expect(screen.queryByTestId("rail-radio-now-genres")).toBeNull();
      // The station keeps its name and its stop button: the failure is ABOUT
      // this row, it does not replace it.
      expect(screen.getByTestId("rail-radio-now-title")).toHaveTextContent(station.title);
      expect(screen.getByTestId("rail-radio-stop")).toBeInTheDocument();
    });

    it("takes precedence over a track the feed is still reporting", async () => {
      render(() => <RailRadio />);
      openRadioPicker();
      screen.getByTestId(`rail-radio-station-${station.id}`).click();
      await vi.waitFor(() =>
        expect(screen.getByTestId("rail-radio-now-track")).toBeInTheDocument(),
      );

      reportPlaybackFailure({ code: 2, message: "" } as MediaError);

      expect(screen.queryByTestId("rail-radio-now-track")).toBeNull();
      expect(screen.getByTestId("rail-radio-now-error")).toBeInTheDocument();
    });

    it("clears when the operator picks another station", () => {
      render(() => <RailRadio />);
      openRadioPicker();
      screen.getByTestId(`rail-radio-station-${station.id}`).click();
      reportPlaybackFailure({ code: 2, message: "" } as MediaError);

      screen.getByTestId(`rail-radio-station-${other.id}`).click();

      expect(screen.queryByTestId("rail-radio-now-error")).toBeNull();
      expect(screen.getByTestId("rail-radio-now-genres")).toBeInTheDocument();
    });
  });
});
