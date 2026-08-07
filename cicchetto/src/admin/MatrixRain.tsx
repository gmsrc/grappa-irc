import { type Component, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

// Decorative amber character rain, admin console only.
//
// Constraints that are NOT preferences, and why:
//
//   * `prefers-reduced-motion` turns it OFF, not down. A full-viewport
//     animation is the exact case that setting exists for.
//   * One rAF loop at ~15fps, cancelled on cleanup. This shares a phone
//     with diag readouts that re-render on every resize event.
//   * Canvas, not DOM — a few hundred animated glyph nodes would fight
//     the pane for layout every frame.
//   * `pointer-events: none`, so it can never take a tap meant for a
//     control underneath.
//   * Low alpha: it has to stay readable-through.

const GLYPHS = "01アイウエオカキクケコサシスセソタチツテトナニヌネノ<>[]{}/\\|=+*#$%&";
const FONT_SIZE = 14;
const FRAME_MS = 66;

// No props: the caller gates it with `<Show>`, so being MOUNTED is the
// on state and unmounting stops the loop through `onCleanup`. An `on`
// prop would be a second switch that has to agree with the first.
const MatrixRain: Component = () => {
  let canvas: HTMLCanvasElement | undefined;

  onMount(() => {
    const el = canvas;
    if (el === undefined) return;

    // Off, not slowed — see the moduledoc. `matchMedia` is absent in
    // jsdom, so a missing implementation reads as "no preference".
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced) return;

    const ctx = el.getContext("2d");
    if (ctx === null) return;

    let columns: number[] = [];
    const resize = (): void => {
      el.width = window.innerWidth;
      el.height = window.innerHeight;
      columns = new Array(Math.ceil(el.width / FONT_SIZE)).fill(0);
      ctx.font = `${FONT_SIZE}px monospace`;
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    let last = 0;
    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw);
      if (now - last < FRAME_MS) return;
      last = now;

      // The fade that leaves the trails: paint the whole canvas a barely
      // opaque black each frame rather than clearing it.
      ctx.fillStyle = "rgba(0, 0, 0, 0.10)";
      ctx.fillRect(0, 0, el.width, el.height);

      for (let i = 0; i < columns.length; i++) {
        const y = (columns[i] ?? 0) * FONT_SIZE;
        const glyph = GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? "0";
        ctx.fillStyle = "rgba(255, 176, 0, 0.18)";
        ctx.fillText(glyph, i * FONT_SIZE, y);
        // Reset a column at random once it is past the bottom, so the
        // rows never fall into lockstep.
        columns[i] = y > el.height && Math.random() > 0.975 ? 0 : (columns[i] ?? 0) + 1;
      }
    };
    raf = requestAnimationFrame(draw);

    onCleanup(() => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    });
  });

  // Portalled to `<body>` and painted over the pane, not under it. Two
  // reasons, both load-bearing: `position: fixed` is only
  // viewport-fixed when no ancestor is transformed, and the shell
  // transforms for its drawers; and inside the pane the canvas landed
  // beneath `.adm-scroll`'s opaque background, where it rendered
  // perfectly and was never visible.
  //
  // On top is also the correct look — it is light cast over the room,
  // not a wallpaper behind furniture — and it is safe because the layer
  // is `pointer-events: none` and blends by `screen`.
  //
  // The canvas sits inside an `aria-hidden` div rather than carrying the
  // hint itself: a `<canvas>` is focusable, and `aria-hidden` on a
  // focusable element is a real defect. The wrapper is not focusable, so
  // the hint belongs there; `tabindex={-1}` keeps the canvas out of the
  // tab order.
  return (
    <Portal>
      <div class="adm-rain" aria-hidden="true" data-testid="admin-matrix-rain">
        <canvas
          tabindex={-1}
          ref={(node) => {
            canvas = node;
          }}
        />
      </div>
    </Portal>
  );
};

export default MatrixRain;
