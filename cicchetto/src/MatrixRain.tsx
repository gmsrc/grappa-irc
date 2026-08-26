import { type Component, onCleanup, onMount } from "solid-js";

// Decorative amber character rain. Absolutely positioned inside its
// parent, which must be `position: relative` and clip its overflow.
//
// #1773 moved this OUT of `src/admin/` and gave it two required props. It
// had one consumer (the Debug tab's `.adm-matrix` phosphor panel) and now
// has two (the credits easter egg's full-screen modal), and a shared
// component sitting in the admin-only directory is a lie the next reader
// trips on. The props are the only thing that differs between the two
// surfaces — everything below, including the four constraints, is one
// implementation. NOT defaulted: a default class would silently give the
// second caller the first caller's stylesheet hook.
//
// #1807 made the four DRAWING knobs a prop for the same reason. The credits
// modal read as a faint texture rather than as rain and needed all four
// louder; the Debug panel needs exactly what it had, because it rains behind
// readouts an operator must read THROUGH. Hardcoding the louder values here
// would have changed a surface nobody asked to change, so `look` carries
// them and each surface owns its own. Not CSS custom properties: reading
// them costs a style recalc inside the frame loop, jsdom resolves them to
// empty (so every knob would need a fallback, which is the silent default
// this component has refused since #1773), and the burst below is a
// FUNCTION of time that no custom property can express.
//
// Sized off the PARENT box rather than the window: it is a panel effect,
// not a page overlay, so it must follow the panel through a resize, a
// keyboard slide-in, or a column reflow. A `ResizeObserver` is the only
// thing that sees all three; `window.resize` misses the last two.
//
// Constraints that are NOT preferences, and why:
//
//   * `prefers-reduced-motion` turns it OFF, not down, and is watched
//     LIVE rather than read once at mount — a user who enables it while
//     this is running is the case the setting most needs to work for.
//   * One rAF loop at ~15fps, cancelled on cleanup. This shares a phone
//     with diag readouts that re-render on every resize event. `look` is
//     read INSIDE that loop, once per drawn frame, so a caller that varies
//     the effect over time does it on this clock and never starts a second
//     one — a `setTimeout` would drift exactly where it matters, in a
//     backgrounded tab where rAF stops and timers do not.
//   * Canvas, not DOM — a few hundred animated glyph nodes would fight
//     the pane for layout every frame.
//   * `pointer-events: none`, so it can never take a tap meant for a
//     control underneath.

const GLYPHS = "01アイウエオカキクケコサシスセソタチツテトナニヌネノ<>[]{}/\\|=+*#$%&";
const FONT_SIZE = 14;
const FRAME_MS = 66;
// `fillText`'s default baseline is alphabetic, so a glyph drawn at `y`
// occupies roughly [y - FONT_SIZE, y + DESCENDER]. The punch below has to
// cover the descender too, or a tail of the previous head survives it.
const DESCENDER = 4;

/** The trail colour. Amber is the phosphor both surfaces are built around;
    only its alpha is per-surface, so the hue is not a knob. */
const TRAIL_RGB = "255, 176, 0";

/**
 * The four drawing knobs, per surface (#1807). Every one of them was a
 * literal in the loop below until the credits modal needed all four louder
 * than the Debug panel can afford.
 */
export type MatrixRainLook = {
  /** Alpha of a glyph once the leader has moved past it. */
  readonly glyphAlpha: number;
  /** Per-frame black wash over the whole canvas. LOWER leaves a longer
      streak: the trail dies as `(1 - fadeAlpha)^frames`. */
  readonly fadeAlpha: number;
  /** Fill for the head of each column, or `null` to paint it like the rest
      of the trail — which is what the effect did before #1807, and what the
      Debug panel still asks for. */
  readonly leader: string | null;
  /** Rows advanced per drawn frame. Fractional: the speed must not come
      from the frame budget, because at ~6fps the columns visibly step. */
  readonly rowsPerFrame: number;
};

// No `on` prop: the caller gates it with `<Show>`, so being MOUNTED is the
// on state and unmounting stops the loop through `onCleanup`. An `on`
// prop would be a second switch that has to agree with the first.
type MatrixRainProps = {
  /** Stylesheet hook on the wrapper. The parent it sits in must be
      `position: relative` and clip its overflow. */
  readonly class: string;
  /** `data-testid` on the wrapper, so each surface is addressable on its
      own — a shared id would make a spec unable to say WHICH rain it found. */
  readonly testId: string;
  /** What the rain should look like RIGHT NOW. Called once per drawn frame
      from inside the loop, so a surface whose effect varies over time (the
      credits interlude burst) answers on this clock instead of running one
      of its own. A surface with a fixed look returns a constant. */
  readonly look: () => MatrixRainLook;
};

/** The head of a column as it was painted last frame, so the next frame can
    cool it down to the trail colour. `null` until the column has a head. */
type Head = { readonly y: number; readonly glyph: string };

const MatrixRain: Component<MatrixRainProps> = (props) => {
  let canvas: HTMLCanvasElement | undefined;

  onMount(() => {
    const el = canvas;
    if (el === undefined) return;

    // Off, not slowed — see the moduledoc. `matchMedia` is absent in
    // jsdom, so a missing implementation reads as "no preference".
    //
    // LIVE, not once: read at mount only, a user who turns the setting on
    // while this is running keeps the animation until they navigate away,
    // which is the one case the setting most needs to work. The listener
    // stops the loop in place; turning it back off does not restart it,
    // because resuming an animation someone just asked to stop is the
    // wrong side to err on — closing and reopening the panel does that.
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    if (mq?.matches === true) return;

    const ctx = el.getContext("2d");
    if (ctx === null) return;

    let columns: number[] = [];
    let heads: (Head | null)[] = [];
    const resize = (): void => {
      const box = el.parentElement;
      if (box === null) return;
      el.width = box.clientWidth;
      el.height = box.clientHeight;
      const count = Math.ceil(el.width / FONT_SIZE);
      columns = new Array(count).fill(0);
      // Dropped rather than kept: after a reflow the previous heads name
      // cells that may not exist, and demoting a stale one would punch a
      // hole in a column it no longer belongs to.
      heads = new Array(count).fill(null);
      ctx.font = `${FONT_SIZE}px monospace`;
    };
    resize();

    const observer = new ResizeObserver(resize);
    if (el.parentElement !== null) observer.observe(el.parentElement);

    let raf = 0;
    let last = 0;
    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw);
      if (now - last < FRAME_MS) return;
      last = now;

      const look = props.look();
      const trail = `rgba(${TRAIL_RGB}, ${look.glyphAlpha})`;

      // The fade that leaves the trails: paint the whole canvas a barely
      // opaque black each frame rather than clearing it.
      ctx.fillStyle = `rgba(0, 0, 0, ${look.fadeAlpha})`;
      ctx.fillRect(0, 0, el.width, el.height);

      for (let i = 0; i < columns.length; i++) {
        const row = columns[i] ?? 0;
        // Rounded HERE and nowhere else: the counter stays fractional so a
        // sub-row speed is possible at the same frame budget.
        const y = Math.round(row) * FONT_SIZE;
        const x = i * FONT_SIZE;
        const glyph = GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? "0";

        if (look.leader === null) {
          ctx.fillStyle = trail;
          ctx.fillText(glyph, x, y);
        } else {
          const head = heads[i] ?? null;
          if (head !== null && head.y !== y) {
            // Cool last frame's head to the trail colour. The wash alone
            // cannot do it — it only decays whatever is already there, so a
            // near-opaque head would leave a near-opaque STREAK and the two
            // alphas would name one pixel at two ages instead of two things.
            // The punch is what makes the repaint replace rather than tint;
            // opaque black is invisible under the `screen` blend both
            // surfaces composite with, so it costs no visible hole.
            ctx.fillStyle = "#000";
            ctx.fillRect(x, head.y - FONT_SIZE, FONT_SIZE, FONT_SIZE + DESCENDER);
            ctx.fillStyle = trail;
            // The SAME glyph, not a fresh roll: a demotion should read as a
            // colour cooling, not as the character flickering.
            ctx.fillText(head.glyph, x, head.y);
          }
          ctx.fillStyle = look.leader;
          ctx.fillText(glyph, x, y);
          heads[i] = { y, glyph };
        }

        // Reset a column at random once it is past the bottom, so the
        // rows never fall into lockstep.
        columns[i] = y > el.height && Math.random() > 0.975 ? 0 : row + look.rowsPerFrame;
      }
    };
    raf = requestAnimationFrame(draw);

    const onReducedChange = (e: MediaQueryListEvent): void => {
      if (e.matches) cancelAnimationFrame(raf);
    };
    mq?.addEventListener("change", onReducedChange);

    onCleanup(() => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      mq?.removeEventListener("change", onReducedChange);
    });
  });

  // The canvas is `aria-hidden` through a wrapper rather than on itself:
  // a `<canvas>` is focusable, and `aria-hidden` on a focusable element
  // is a real defect — a screen-reader user could tab into something
  // that announces nothing. The wrapper is not focusable, so the hint
  // belongs there; `tabindex={-1}` keeps the canvas out of the tab order.
  return (
    <div class={props.class} aria-hidden="true" data-testid={props.testId}>
      <canvas
        tabindex={-1}
        ref={(node) => {
          canvas = node;
        }}
      />
    </div>
  );
};

export default MatrixRain;
