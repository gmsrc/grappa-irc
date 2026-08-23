import { type Component, For, Show } from "solid-js";
import { closeAudio } from "./lib/audioPlayer";
import { createDismissOnOutsidePointer } from "./lib/dismissOnOutsidePointer";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { closeRadioPicker, radioPickerOpen, tunedStation, tuneStation } from "./lib/radio";
import { RADIO_STATIONS } from "./lib/radioStations";

// #682 — the rail's internet-radio surface: a station PICKER and, once
// something is tuned, the station CHROME. Two views of the ONE audio player.
//
// WHY THE TRANSPORT IS NOT HERE. Play/pause/elapsed stay on the docked
// `AudioMiniPlayer` above the compose box, and that split is forced, not
// stylistic: on mobile `.shell-members` is `position: fixed` with
// `transform: translateX(100%)`, sliding in only on `.open`
// (themes/default.css). A transport living only in the rail is therefore
// UNREACHABLE on a phone while it plays. So the rail gets picking and
// identity, the docked bar keeps the controls, and there is exactly one
// <audio> element and one `audioPlayer` store under both.
//
// WHY NOT AN ARM OF `RailContext`. That component grafts content BY THE
// ACTIVE WINDOW'S KIND and renders nothing for kinds it has no arm for, so a
// radio panel hosted there would vanish the moment the operator switched to a
// query — the exact opposite of what the docked player already guarantees.
// This mounts unconditionally inside `.shell-members`, kind-independent, the
// way `RailActions` does, from BOTH branches of Shell's `isMobile()` split.
//
// VERTICAL BUDGET (#500). #500 collapsed the rail actions behind one pinned
// launcher because an always-expanded column pushed them below the fold on a
// long nick list. A permanent radio panel would re-charge exactly that cost,
// so: idle renders NOTHING (no chrome, no picker, zero height), the chrome
// appears only once the operator has tuned something and is one compact row
// that takes its space from the scrolling `.members-pane` rather than from
// the floored `RailActions`, and the picker is an OVERLAY.
//
// The picker overlays the whole rail (`position: absolute; inset: 0` against
// `.shell-members`, which is already `position: relative` for the resize
// handle) instead of copying the `.rail-actions-menu` popover shape. That is
// not just simpler, it side-steps the two bugs that shape cost: anchoring a
// menu at `bottom: 100%` of a bottom-pinned launcher is what made #588 (the
// cap must be the space ABOVE, not the viewport) and #913 (that space is
// measured from the physical top under `viewport-fit=cover`) necessary. An
// inset-0 overlay's height IS the rail, so CSS bounds it with no measurement
// at all — and `.shell-members` already carries the `min-height: 0` that
// bounds it to the grid track.
//
// Dismiss reuses both shared verbs: `createOverlayLock` for the ordered
// Escape stack and the refcount scroll-lock that keeps the rail's
// `touch-action: pan-y` contract intact on mobile, and
// `createDismissOnOutsidePointer` for the non-blocking outside click.
//
// Picking does NOT close the picker. RailActions states the rule already: a
// launcher that NAVIGATES away is single-shot, a control the operator flips
// in place and re-flips — `denoise` there — is not. Auditioning stations is
// the second kind, so the picker stays up and marks the tuned row.

const RailRadio: Component = () => {
  let rootRef: HTMLDivElement | undefined;

  createOverlayLock(() => radioPickerOpen(), ".rail-radio-picker", closeRadioPicker);
  createDismissOnOutsidePointer(radioPickerOpen, () => rootRef, closeRadioPicker);

  return (
    <div class="rail-radio" ref={rootRef}>
      {/* Station chrome — the rail's answer to "what is playing", present
          only while something is. The docked transport carries the same name
          for the phone, where this rail is slid off-screen. */}
      <Show when={tunedStation()}>
        {(station) => (
          <div class="rail-radio-now" data-testid="rail-radio-now">
            {/* Decorative: the title beside it already names the station, so
                alt text would be read out twice by a screen reader. */}
            <img class="rail-radio-now-logo" src={station().logoUrl} alt="" />
            <div class="rail-radio-now-text">
              <span class="rail-radio-now-title" data-testid="rail-radio-now-title">
                {station().title}
              </span>
              <span class="rail-radio-now-genres">{station().genres.join(" · ")}</span>
            </div>
            {/* `closeAudio` directly: it already IS the stop verb, and the
                station is derived from the player, so clearing the player is
                what un-tunes. No radio-flavoured wrapper around it. */}
            <button
              type="button"
              class="rail-radio-stop"
              data-testid="rail-radio-stop"
              onClick={closeAudio}
              aria-label="stop radio"
            >
              {"⏹"}
            </button>
          </div>
        )}
      </Show>

      <Show when={radioPickerOpen()}>
        <div class="rail-radio-picker" data-testid="rail-radio-picker">
          <div class="rail-radio-picker-head">
            {/* Mirrors the MembersPane `<h3>` slot (uppercased by CSS), the
                established heading shape for rail content. */}
            <h3 class="rail-radio-heading">radio</h3>
            <button
              type="button"
              class="rail-radio-picker-close"
              data-testid="rail-radio-picker-close"
              onClick={closeRadioPicker}
              aria-label="close radio picker"
            >
              {"✕"}
            </button>
          </div>
          <For each={RADIO_STATIONS}>
            {(station) => (
              <button
                type="button"
                class="rail-radio-station"
                classList={{ tuned: tunedStation()?.id === station.id }}
                data-testid={`rail-radio-station-${station.id}`}
                onClick={() => tuneStation(station)}
                /* aria-pressed, not aria-selected: these are toggle buttons in
                   a plain container, not options in a listbox — and it is what
                   marks the tuned row for a screen reader, matching the visual
                   `.tuned` class. */
                aria-pressed={tunedStation()?.id === station.id ? "true" : "false"}
                title={station.description}
              >
                <img class="rail-radio-station-logo" src={station.logoUrl} alt="" />
                <span class="rail-radio-station-text">
                  <span class="rail-radio-station-title">{station.title}</span>
                  <span class="rail-radio-station-genres">{station.genres.join(" · ")}</span>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default RailRadio;
