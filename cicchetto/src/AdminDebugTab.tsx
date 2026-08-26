import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import AdminCard from "./admin/AdminCard";
import { isDiagEnabled, setDiagEnabled } from "./DiagFloat";
import MatrixRain, { type MatrixRainLook } from "./MatrixRain";

// UX-6 D12 (2026-05-21) — Admin → Debug tab. Hosts the iOS PWA
// keyboard / viewport diagnostics. Previously lived inside
// SettingsDrawer (as a fieldset) where the visibility was bound to
// the drawer's open state — closing the drawer to test the keyboard
// path hid the very diag we needed to read. Lifted into a dedicated
// admin tab so the diag readouts are reachable from a stable
// surface without competing with focus-state of the surface under
// investigation.
//
// Two affordances:
// 1. "floating diag overlay" toggle — flips localStorage.cic_diag
//    which DiagFloat polls every 1s. Floating overlay is the
//    primary read surface during keyboard slide-in (renders via
//    Portal to body, escapes any shell transform, stays at top-right
//    of layout viewport).
// 2. Inline live readouts + event log — supplementary, useful when
//    the admin is not on a touch device but wants to inspect
//    visualViewport behavior on resize.
//
// Read-only DOM probes, zero side effects on production paths.
// Read-write of localStorage.cic_diag is the only state change.
//
// Per-class parity matrix (`feedback_e2e_user_class_parity_matrix`):
// admin-gated, EXEMPT. e2e coverage at m7-admin-gate proves
// non-admin can't reach AdminPane at all; this tab inherits.

/**
 * What the phosphor rain looks like here — and it is deliberately EXACTLY
 * what `MatrixRain` hardcoded before #1807 made the knobs per-surface,
 * measured on `4c9270c5`.
 *
 * #1807 made the credits modal's rain loud, because there the rain IS the
 * picture. Here it is not: it falls BEHIND viewport readouts an operator is
 * trying to read, and low alpha plus a short trail is what keeps them
 * readable-through. `leader: null` is the same statement about shape — no
 * bright head, one glyph per column per frame, which is the drawing the
 * panel has always had.
 *
 * Exported so `AdminDebugTab.test.tsx` can pin the four values against that
 * commit without re-typing them.
 */
export const ADM_RAIN_LOOK: MatrixRainLook = {
  glyphAlpha: 0.18,
  fadeAlpha: 0.1,
  leader: null,
  rowsPerFrame: 1,
};

const AdminDebugTab: Component = () => {
  const [diagWinH, setDiagWinH] = createSignal(0);
  const [diagWinW, setDiagWinW] = createSignal(0);
  const [diagVvH, setDiagVvH] = createSignal(0);
  const [diagVvW, setDiagVvW] = createSignal(0);
  const [diagVvScale, setDiagVvScale] = createSignal(1);
  const [diagVvOffsetTop, setDiagVvOffsetTop] = createSignal(0);
  const [diagCssVar, setDiagCssVar] = createSignal("");
  const [diagVhVar, setDiagVhVar] = createSignal("");
  const [diagIsIos, setDiagIsIos] = createSignal(false);
  const [diagEventTick, setDiagEventTick] = createSignal(0);
  const [diagLastEvent, setDiagLastEvent] = createSignal<string>("(none)");
  const [diagFocusedTag, setDiagFocusedTag] = createSignal<string>("(none)");
  const [diagElems, setDiagElems] = createSignal<string>("(none)");
  const [diagLog, setDiagLog] = createSignal<string[]>([]);
  const [diagFloatOn, setDiagFloatOn] = createSignal(isDiagEnabled());

  // Counter resets on the toggle rather than on a timer — no reason to
  // make this depend on how fast anyone taps.
  const [rainTaps, setRainTaps] = createSignal(0);
  const [rainOn, setRainOn] = createSignal(false);

  const tapHeading = (): void => {
    const next = rainTaps() + 1;
    if (next >= 5) {
      setRainTaps(0);
      setRainOn((v) => !v);
      return;
    }
    setRainTaps(next);
  };

  const snapshotDiag = (eventName: string): void => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const winH = typeof window !== "undefined" ? window.innerHeight : 0;
    const winW = typeof window !== "undefined" ? window.innerWidth : 0;
    const vvH = vv?.height ?? 0;
    const vvW = vv?.width ?? 0;
    setDiagWinH(winH);
    setDiagWinW(winW);
    setDiagVvH(vvH);
    setDiagVvW(vvW);
    setDiagVvScale(vv?.scale ?? 1);
    setDiagVvOffsetTop(vv?.offsetTop ?? 0);
    setDiagCssVar(
      typeof document !== "undefined"
        ? document.documentElement.style.getPropertyValue("--viewport-height") || "(unset)"
        : "(no document)",
    );
    setDiagVhVar(
      typeof document !== "undefined"
        ? document.documentElement.style.getPropertyValue("--vh") || "(unset)"
        : "(no document)",
    );
    setDiagIsIos(
      typeof document !== "undefined" && document.documentElement.classList.contains("is-ios"),
    );
    setDiagEventTick((n) => n + 1);
    setDiagLastEvent(eventName);
    setDiagFocusedTag(
      typeof document !== "undefined" && document.activeElement
        ? `${document.activeElement.tagName}${
            (document.activeElement as HTMLElement).id
              ? `#${(document.activeElement as HTMLElement).id}`
              : ""
          }`
        : "(none)",
    );
    const probe = (sel: string): string => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return `${sel}=∅`;
      const cs = getComputedStyle(el);
      const ch = el.clientHeight;
      const sh = el.scrollHeight;
      const tag = sel.replace(/[.#]/g, "").replace(/-/g, "").slice(0, 4);
      const shStr = sh !== ch ? `/${sh}` : "";
      return `${tag}=${ch}${shStr}[${cs.minHeight}]`;
    };
    const elemSummary = [
      probe(".shell-mobile"),
      probe(".shell-mobile .shell-main"),
      probe(".scrollback-pane"),
      probe(".scrollback"),
      probe(".compose-box"),
      probe(".bottom-bar"),
    ].join(" ");
    setDiagElems(elemSummary);
    const delta = winH - vvH;
    const line = `${eventName} vv=${Math.round(vvH)} win=${Math.round(winH)} Δ=${Math.round(delta)} ${elemSummary}`;
    setDiagLog((prev) => [line, ...prev].slice(0, 20));
  };

  onMount(() => {
    snapshotDiag("mount");
    const onResize = () => snapshotDiag("resize");
    const onVvResize = () => snapshotDiag("vv.resize");
    const onVvScroll = () => snapshotDiag("vv.scroll");
    const onFocusIn = () => snapshotDiag("focusin");
    const onFocusOut = () => snapshotDiag("focusout");
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onVvResize);
    window.visualViewport?.addEventListener("scroll", onVvScroll);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onVvResize);
      window.visualViewport?.removeEventListener("scroll", onVvScroll);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    });
  });

  return (
    <div class="admin-debug-tab" data-testid="admin-debug-tab">
      {/* Admin redesign (2026-08-07) — onto the cards and the shared
          `.adm-facts` list, like every other tab.

          With ONE deliberate divergence: the readouts render on a
          phosphor-green terminal panel rather than the theme's surfaces.
          It is the only place in the pane that does not follow the
          active theme — allowed here because this is
          the debug tab, it is admin-gated, and nobody lands on it by
          accident. Everything OUTSIDE the panel (cards, headings,
          controls) stays themed, so the tab still reads as part of the
          console rather than as a different application. */}
      <div class="adm-scroll">
        <AdminCard title="Floating overlay" subtitle="live during the keyboard slide-in">
          <div class="adm-field-rows">
            <div class="adm-field">
              <label class="adm-field-label" for="diag-float-toggle">
                show floating diag overlay
              </label>
              <label class="adm-check">
                <input
                  id="diag-float-toggle"
                  type="checkbox"
                  checked={diagFloatOn()}
                  onChange={(e) => {
                    const v = e.currentTarget.checked;
                    setDiagEnabled(v);
                    setDiagFloatOn(v);
                  }}
                  data-testid="diag-float-toggle"
                />
                top-right, above everything
              </label>
            </div>
          </div>
        </AdminCard>

        <AdminCard title="Viewport diagnostics" subtitle="read-only probes, no side effects">
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: decorative only —
              no keyboard action worth exposing. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: same. */}
          <div class="adm-matrix" onClick={tapHeading}>
            <Show when={rainOn()}>
              <MatrixRain class="adm-rain" testId="admin-matrix-rain" look={() => ADM_RAIN_LOOK} />
            </Show>
            <p class="adm-matrix-prompt" aria-hidden="true">
              grappa@cicchetto:~$ tail -f /dev/viewport
            </p>
            {/* #1244 — `.adm-fact` per pair, like `AdminFacts` renders.
                This list is hand-written because each value is its own
                signal read, and it shares the class, so it shares the
                markup contract: the narrow layout keys off the wrapper,
                and a `.adm-facts` without one silently keeps the old
                grid the day this panel gains a query container. */}
            <dl class="adm-facts adm-matrix-facts">
              <div class="adm-fact">
                <dt>vv.height</dt>
                <dd data-testid="diag-vv-h">{Math.round(diagVvH())}</dd>
              </div>
              <div class="adm-fact">
                <dt>vv.width</dt>
                <dd data-testid="diag-vv-w">{Math.round(diagVvW())}</dd>
              </div>
              <div class="adm-fact">
                <dt>window.innerHeight</dt>
                <dd data-testid="diag-win-h">{Math.round(diagWinH())}</dd>
              </div>
              <div class="adm-fact">
                <dt>window.innerWidth</dt>
                <dd data-testid="diag-win-w">{Math.round(diagWinW())}</dd>
              </div>
              <div class="adm-fact">
                <dt>Δ (winH − vvH)</dt>
                <dd data-testid="diag-delta">{Math.round(diagWinH() - diagVvH())}</dd>
              </div>
              <div class="adm-fact">
                <dt>vv.scale</dt>
                <dd>{diagVvScale().toFixed(2)}</dd>
              </div>
              <div class="adm-fact">
                <dt>vv.offsetTop</dt>
                <dd>{Math.round(diagVvOffsetTop())}</dd>
              </div>
              <div class="adm-fact">
                <dt>--viewport-height</dt>
                <dd data-testid="diag-css-var">{diagCssVar()}</dd>
              </div>
              <div class="adm-fact">
                <dt>--vh</dt>
                <dd data-testid="diag-vh-var">{diagVhVar()}</dd>
              </div>
              <div class="adm-fact">
                <dt>html.is-ios</dt>
                <dd data-testid="diag-is-ios">{diagIsIos() ? "true" : "false"}</dd>
              </div>
              <div class="adm-fact">
                <dt>active element</dt>
                <dd data-testid="diag-focus">{diagFocusedTag()}</dd>
              </div>
              <div class="adm-fact">
                <dt>event tick</dt>
                <dd data-testid="diag-event-tick">{diagEventTick()}</dd>
              </div>
              <div class="adm-fact">
                <dt>last event</dt>
                <dd data-testid="diag-last-event">{diagLastEvent()}</dd>
              </div>
            </dl>
          </div>
        </AdminCard>

        <AdminCard title="Element chain" subtitle="clientH/scrollH [minH]">
          <div class="adm-matrix">
            <p class="adm-matrix-line" data-testid="diag-elems">
              {diagElems()}
            </p>
          </div>
        </AdminCard>

        <AdminCard title="Event log" subtitle="newest first, last 20">
          <div class="adm-matrix">
            <ol class="adm-matrix-log">
              <For each={diagLog()} fallback={<li class="adm-matrix-line">awaiting input…</li>}>
                {(line) => <li class="adm-matrix-line">{line}</li>}
              </For>
            </ol>
          </div>
        </AdminCard>
      </div>
    </div>
  );
};

export default AdminDebugTab;
