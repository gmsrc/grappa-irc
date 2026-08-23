import { createSignal } from "solid-js";
import { activeAudio, playAudio } from "./audioPlayer";
import { identityScopedStore } from "./identityScopedStore";
import { RADIO_STATIONS, type RadioStation } from "./radioStations";

// #682 — internet-radio store. It is deliberately almost empty, and what is
// NOT here is the design:
//
// THE TUNED STATION IS DERIVED, NOT STORED. There is exactly one <audio>
// element and one `audioPlayer` store behind it (#115), and a station is just
// another href handed to it. So "which station is playing" is already written
// down — in `activeAudio()` — and a second signal tracking it would be a
// parallel structure needing housekeeping that will drift (CLAUDE.md design
// discipline: derive, don't duplicate). The drift is not hypothetical: click
// an audio link in scrollback while a station plays and the source swaps
// under the station. A stored flag would still claim the station is on; the
// derivation below cannot, and neither can it miss `closeAudio()`, the ✕ on
// the transport, or the identity-rotation reset that store already performs.
//
// So this module owns ONE signal — whether the picker is open — and that one
// is genuinely local ephemeral UI state, the same kind as Shell's
// `membersOpen` / `settingsOpen`. cic-never-originates-state governs IRC
// WINDOW state, not a client-side drawer toggle.
//
// There is no `stopStation` verb: `closeAudio()` from the audio store already
// is that verb, and wrapping it under a radio-flavoured name would be a
// second noun for one behaviour (CLAUDE.md: reuse the verbs, not the nouns).
//
// Identity scoping: the picker resets on rotation like every other cic store.
// The TUNED station needs no reset of its own — `audioPlayer` clears on
// rotation and this derives from it, which is one more thing the derivation
// gets right for free.

const exports_ = identityScopedStore((onIdentityChange) => {
  const [radioPickerOpen, setRadioPickerOpen] = createSignal(false);

  // A logout or rotation must not hand the next identity a rail with someone
  // else's picker hanging open over it.
  onIdentityChange(() => setRadioPickerOpen(false));

  return {
    radioPickerOpen,
    openRadioPicker: (): void => {
      setRadioPickerOpen(true);
    },
    closeRadioPicker: (): void => {
      setRadioPickerOpen(false);
    },
    toggleRadioPicker: (): void => {
      setRadioPickerOpen((v) => !v);
    },
  };
});

export const { radioPickerOpen, openRadioPicker, closeRadioPicker, toggleRadioPicker } = exports_;

// Start (or swap to) a station. Routes through the ONE player — no second
// <audio>, no stacking — and hands it the title, which is what the docked
// transport captions playback with. That caption is not decoration: on mobile
// the rail holding the station chrome is a drawer slid off-screen while
// playing, so the docked bar is the only surface naming the station.
//
// It deliberately does NOT close the picker. RailActions already states the
// rule this follows: a launcher that NAVIGATES away closes the menu, while a
// control the operator flips in place — `denoise` there — does not. Tuning is
// the second kind: the operator auditions stations and re-picks.
export function tuneStation(station: RadioStation): void {
  playAudio(station.streamUrl, station.title);
}

// Which station, if any, the single player is currently on. Reactive: it
// tracks `activeAudio`, so it re-reads whenever the source swaps for ANY
// reason — a second station, an audio upload taking the player over, the
// transport's ✕, or identity rotation.
//
// Matching on the href is what makes it total: an upload's href is in no
// station's table row, so it answers null without anything having to notice
// that an upload happened.
export function tunedStation(): RadioStation | null {
  const href = activeAudio()?.href;
  if (href === undefined) return null;
  return RADIO_STATIONS.find((s) => s.streamUrl === href) ?? null;
}
