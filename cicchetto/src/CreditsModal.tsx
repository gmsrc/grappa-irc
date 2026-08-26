import { type Component, createEffect, For, onCleanup, Show, untrack } from "solid-js";
import { buildCredits, creditsDateLabel } from "./lib/buildCredits";
import { bootBundleVersionAccessor } from "./lib/bundleHash";
import { type CreditsArpeggio, startCreditsArpeggio } from "./lib/creditsAudio";
import {
  closeCreditsModal,
  creditsModalOpen,
  creditsMuted,
  toggleCreditsMuted,
} from "./lib/creditsModal";
import { CREDITS_RAIN_LOOK } from "./lib/creditsRain";
import { createOverlayLock } from "./lib/overlayScrollLock";
import MatrixRain from "./MatrixRain";

// #1773 — the credits easter egg: falling characters behind an end-titles
// roll, on a loop, with a synthesised soundtrack.
//
// Mounted in Shell, not in SettingsDrawer, and that is structural rather than
// tidiness: `.settings-drawer` animates on `transform`, which makes it the
// containing block for any `position: fixed` descendant — a full-screen modal
// rendered inside it would be clipped to the drawer. Same reason
// ShareSessionModal, opened from the same drawer, lives in Shell.
//
// `createOverlayLock`, NOT `createOverlayEscape`: this covers the whole
// viewport, so without the scroll-lock refcount the iOS shell pans behind it
// (the live #1772 bug). The scrollback freeze the lock also brings is WANTED
// here for the same reason — nothing of the pane is visible to keep live.
//
// Every fact on screen comes from a source that already existed:
//   * the version from `<meta name="cicchetto-version">` via
//     `bundleHash.bootBundleVersionAccessor` (#292 — ONE injection point, and
//     a second carrier is the drift #538 closed);
//   * the sha, its date and the contributor list from `buildCredits()`, baked
//     by infra/packaging/credits.sh through the same wrapper channel.
//
// Both degrade to "unknown" rather than to blank. A build genuinely can have
// no git — the AUR source tarball and the release image both do — and a roll
// that renders an empty line there reads as a bug in the modal rather than as
// the truth about the build.

const CreditsModal: Component = () => {
  createOverlayLock(() => creditsModalOpen(), ".credits-modal", closeCreditsModal);

  const credits = buildCredits();

  // ── soundtrack lifecycle ────────────────────────────────────────────────
  // Tied to the OPEN signal, not to this component's mount: Shell mounts the
  // component for the whole session, so an onMount-scoped context would be
  // built at boot (before any gesture) and would outlive every close.
  let arpeggio: CreditsArpeggio | null = null;
  const stopArpeggio = (): void => {
    arpeggio?.stop();
    arpeggio = null;
  };

  createEffect(() => {
    if (!creditsModalOpen()) {
      stopArpeggio();
      return;
    }
    if (arpeggio !== null) return;
    // jsdom has no WebAudio, and neither does a browser with it disabled —
    // a silent modal, not a broken one. `webkitAudioContext` is still what
    // older iOS Safari exposes.
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) return;
    // `untrack`: the initial mute state is an INPUT to construction, not a
    // dependency of it. Tracked, a mute toggle would re-run this effect for
    // nothing — the separate effect below is what carries a live toggle.
    arpeggio = startCreditsArpeggio(new Ctor(), untrack(creditsMuted));
  });

  createEffect(() => {
    const muted = creditsMuted();
    arpeggio?.setMuted(muted);
  });

  // A logout unmounts Shell with the modal still open; without this the
  // context survives the session that opened it.
  onCleanup(stopArpeggio);

  const versionLabel = (): string => bootBundleVersionAccessor() ?? "version unknown";
  const dateLabel = (): string | null => creditsDateLabel(credits.date);

  return (
    <Show when={creditsModalOpen()}>
      {/* One fixed full-viewport box, not a backdrop plus a centred dialog:
          the rain IS the backdrop, and a separate scrim would sit between
          them. `.credits-modal` is the selector the overlay lock targets. */}
      <div
        class="credits-modal"
        role="dialog"
        aria-modal="true"
        aria-label="credits"
        data-testid="credits-modal"
      >
        <MatrixRain
          class="credits-rain"
          testId="credits-matrix-rain"
          look={() => CREDITS_RAIN_LOOK}
        />

        <div class="credits-chrome">
          <button
            type="button"
            class="modal-chrome-button credits-mute"
            data-testid="credits-mute"
            aria-pressed={creditsMuted()}
            aria-label={creditsMuted() ? "unmute credits music" : "mute credits music"}
            onClick={toggleCreditsMuted}
          >
            {creditsMuted() ? "🔇" : "🔊"}
          </button>
          <button
            type="button"
            class="modal-chrome-button credits-close"
            data-testid="credits-close"
            aria-label="close credits"
            onClick={closeCreditsModal}
          >
            ×
          </button>
        </div>

        {/* The roll scrolls by CSS animation, so the loop costs no frame
            budget of ours and `prefers-reduced-motion` can turn it into a
            plain scrollable column with one media query — see default.css. */}
        <div class="credits-viewport">
          <div class="credits-roll" data-testid="credits-roll">
            <h2 class="credits-title" data-testid="credits-title">
              GRAPPA IRC
            </h2>
            <p class="credits-version" data-testid="credits-version">
              {versionLabel()}
            </p>
            <p class="credits-build" data-testid="credits-build">
              <span data-testid="credits-sha">{credits.sha ?? "no build sha"}</span>
              <Show when={dateLabel()}>
                {(day) => (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span data-testid="credits-date">{day()}</span>
                  </>
                )}
              </Show>
            </p>

            <h3 class="credits-heading">contributors</h3>
            <ul class="credits-list">
              <For
                each={credits.contributors}
                fallback={
                  // Honest, not blank: this is what a build from a source
                  // tarball looks like, and it is a legitimate build.
                  <li class="credits-empty" data-testid="credits-empty">
                    this build carries no history
                  </li>
                }
              >
                {(person) => (
                  <li class="credits-person" data-testid="credits-person">
                    <span class="credits-person-name">{person.name}</span>
                    <span class="credits-person-count">{person.commits}</span>
                  </li>
                )}
              </For>
            </ul>

            <p class="credits-coda">an always-on IRC bouncer, and a client that looks like irssi</p>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default CreditsModal;
