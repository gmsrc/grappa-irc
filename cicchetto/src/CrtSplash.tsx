import { type Component, For, Show } from "solid-js";
import { channelsBySlug, networks, user } from "./lib/networks";

// #134 — retro CRT splash / loading screen.
//
// LOADING-ONLY by contract. This is the content of the Shell main-pane
// `<Switch fallback>` (desktop + mobile): the fallback only renders when
// `selectedChannel()` is null, which in practice is the cold-load window
// BEFORE Shell's auto-select effect lands on `$home`. The splash animates
// while cic boots, then HANDS OFF to the home window — it is NOT a
// persistent "no-channel-selected" empty state and must never block the
// auto-select handoff.
//
// The `loading` predicate mirrors Shell's cold-load auto-select wait
// EXACTLY (Shell.tsx ~L445-454): `!user()` (/, me not resolved) OR
// `channelsBySlug() === undefined` (createResource is `undefined` while
// loading; a resolved `{}` is truthy → load done, just no channels yet).
// Reusing the same predicate guarantees the splash clears on the same
// reactive tick the handoff fires, with no parallel "still loading"
// notion to drift.
//
// Pattern mirror: InstallSplash.tsx (self-contained splash component +
// `.install-splash*` CSS in themes/default.css). All chrome is CSS/SVG —
// no external asset pipeline, theme-aware via CSS vars. The IRC-text-only
// scrollback invariant is unaffected: this is app chrome, not inline
// scrollback media.

// Retro banner. Flavour only, and now ONLY flavour: the three lines that
// used to sit here claiming "scrollback subsystem ... OK" / "phoenix
// channels link ... OK" / "connecting to bouncer ..." were static text
// that said OK whatever the app was doing. During the stall #687 was
// filed for, the splash was not merely silent — it asserted that
// subsystems were up while the boot sat waiting on a fetch.
const BANNER_LINES: readonly string[] = [
  "GRAPPA TERMINAL  ·  phosphor edition",
  "POST ............................ OK",
];

// #687 — the boot register. One line per stage, marked `done` as it
// resolves, so a stall says WHERE it is stuck instead of looking exactly
// like a healthy 200 ms boot.
//
// THREE stages, not the two the issue names: the boot chain is three
// fetches deep and each is keyed on the one before it —
// `channelsBySlug` ← `networks` ← `user` (lib/networks.ts), the same
// chain `bootFetch`'s moduledoc enumerates. A register that named only
// `me` and `channels` would label a stall in `GET /networks` as a
// channels stall, which is the diagnosis this screen exists to give.
//
// Each `done` reads the SAME resource the `loading` predicate below
// reads. No parallel "boot progress" state to drift out of sync: if the
// register says all three are done, the gate has already handed off.
type BootStage = {
  readonly id: string;
  readonly label: string;
  readonly done: () => boolean;
};

const STAGES: readonly BootStage[] = [
  { id: "me", label: "fetching my info", done: () => !!user() },
  { id: "networks", label: "fetching networks", done: () => networks() !== undefined },
  { id: "channels", label: "fetching channels", done: () => channelsBySlug() !== undefined },
];

const CrtSplash: Component = () => {
  const loading = (): boolean => !user() || channelsBySlug() === undefined;

  return (
    <Show when={loading()}>
      <div
        class="crt-splash"
        data-testid="crt-splash"
        role="status"
        aria-live="polite"
        aria-label="Loading Grappa"
      >
        <div class="crt-splash-screen">
          {/* Boot text + blinking cursor live above the scanline /
              vignette overlays so the phosphor glow reads through. */}
          <div class="crt-splash-content">
            <pre class="crt-splash-boot" aria-hidden="true">
              {BANNER_LINES.join("\n")}
            </pre>
            {/* Not aria-hidden, unlike the banner above: this is the
                only part of the screen carrying information, and the
                container is already `role="status" aria-live="polite"`,
                so each stage is announced as it completes. */}
            <ul class="crt-splash-stages" data-testid="crt-boot-stages">
              <For each={STAGES}>
                {(stage) => (
                  <li
                    class="crt-splash-stage"
                    data-stage={stage.id}
                    data-done={stage.done() ? "true" : "false"}
                  >
                    {stage.label}...
                    <Show when={stage.done()}>
                      <span class="crt-splash-stage-done">{" done"}</span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
            <p class="crt-splash-status">
              <span class="crt-splash-loading-text">LOADING</span>
              <span class="crt-splash-cursor" aria-hidden="true">
                █
              </span>
            </p>
          </div>
          <div class="crt-splash-scanlines" aria-hidden="true" />
          <div class="crt-splash-vignette" aria-hidden="true" />
        </div>
      </div>
    </Show>
  );
};

export default CrtSplash;
