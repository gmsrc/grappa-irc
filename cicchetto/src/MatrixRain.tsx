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
//     with diag readouts that re-render on every resize event.
//   * Canvas, not DOM — a few hundred animated glyph nodes would fight
//     the pane for layout every frame.
//   * `pointer-events: none`, so it can never take a tap meant for a
//     control underneath.
//   * Low alpha: it has to stay readable-through.

const GLYPHS = "01アイウエオカキクケコサシスセソタチツテトナニヌネノ<>[]{}/\\|=+*#$%&";
const FONT_SIZE = 14;
const FRAME_MS = 66;

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
};

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
    const resize = (): void => {
      const box = el.parentElement;
      if (box === null) return;
      el.width = box.clientWidth;
      el.height = box.clientHeight;
      columns = new Array(Math.ceil(el.width / FONT_SIZE)).fill(0);
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
