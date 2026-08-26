import { type Component, onCleanup } from "solid-js";
import {
  clampWidth,
  getSidebarWidth,
  getStoredSidebarWidth,
  maxWidthPx,
  minWidthPx,
  type SidebarSide,
  setSidebarWidth,
} from "./lib/sidebarWidths";

// Desktop drag-resize handle for the left (sidebar) or right (members)
// column of Shell's CSS-grid layout. KISS:
//
//   * Pointer Events API throughout — one code path for mouse/touch/pen.
//   * `setPointerCapture` so the drag survives pointer leaving the
//     element (operator can drag fast + far without losing capture).
//   * During drag the CSS var (`--sidebar-width` / `--members-width`) is
//     mutated DIRECTLY on `<html>` for live visual feedback — no signals,
//     no Solid reactivity, no localStorage thrash. The grid template
//     reflows on every move because the .shell rules consume the vars.
//   * On `pointerup` ONLY: persist via `setSidebarWidth` (one
//     localStorage write per drag).
//   * Side-aware geometry: left handle drags right-edge → width = pointer.x
//     relative to handle's owning <aside> left edge. Right handle drags
//     left-edge → width = (aside right edge) - pointer.x.
//
// Mobile suppression: ResizeHandle is only mounted in Shell.tsx's desktop
// `<Show>` fallback branch; the mobile branch never renders it. The CSS
// also display:none's any stray instance below 768px as defense-in-depth.

interface Props {
  side: SidebarSide;
}

const CSS_VAR: Record<SidebarSide, string> = {
  left: "--sidebar-width",
  right: "--members-width",
};

const ResizeHandle: Component<Props> = (props) => {
  let handleEl: HTMLDivElement | undefined;

  function onPointerDown(e: PointerEvent) {
    if (!handleEl) return;
    // Primary button only — ignore right-click + middle-click + multi-touch
    // secondaries. e.button === 0 covers left-click on mouse + initial touch.
    if (e.button !== 0) return;
    e.preventDefault();
    // jsdom (vitest env) doesn't implement Pointer Capture; guard so
    // unit tests can drive pointerdown without exploding. In real browsers
    // capture helps when the pointer leaves the 6px handle hit area.
    if (typeof handleEl.setPointerCapture === "function") {
      handleEl.setPointerCapture(e.pointerId);
    }
    document.documentElement.classList.add("resize-dragging");

    // The owning aside is the handle's parent — left handle is child of
    // `.shell-sidebar`, right handle is child of `.shell-members`. Direct
    // parent lookup is intentional: any future wrapper layer between
    // ResizeHandle and the aside silently breaks the geometry and the
    // unit/e2e tests would catch it on the next CI run.
    const aside = handleEl.parentElement;
    if (!aside) return;

    function applyLiveWidth(clientX: number) {
      // Re-read aside rect on every move — viewport resize mid-drag
      // (rare) would otherwise leave a stale `.left`/`.right` and the
      // delta math would drift for the remainder of the drag.
      if (!aside) return;
      const r = aside.getBoundingClientRect();
      const raw = props.side === "left" ? clientX - r.left : r.right - clientX;
      // issue 1827 — `clampWidth`, not a second inlined copy of the bound.
      // It is the SAME function `setSidebarWidth` applies on pointerup, which
      // is what lets the comment below still promise that the persisted value
      // equals the one the operator watched; and it is the only reason the
      // short-landscape tier's tighter bounds reach the live drag at all.
      document.documentElement.style.setProperty(CSS_VAR[props.side], `${clampWidth(raw)}px`);
    }

    function onMove(ev: PointerEvent) {
      applyLiveWidth(ev.clientX);
    }

    function onUp(ev: PointerEvent) {
      // Re-derive (don't re-read CSS) — applyLiveWidth + setSidebarWidth
      // apply identical clamping math, so the persisted value matches
      // the operator-visible one without a second getComputedStyle round-trip.
      if (!aside) return;
      const r = aside.getBoundingClientRect();
      const raw = props.side === "left" ? ev.clientX - r.left : r.right - ev.clientX;
      setSidebarWidth(props.side, raw);
      document.documentElement.classList.remove("resize-dragging");
      if (handleEl && typeof handleEl.releasePointerCapture === "function") {
        try {
          handleEl.releasePointerCapture(ev.pointerId);
        } catch {
          // Capture may already be released if pointercancel fired first.
          // Ignored intentionally.
        }
      }
      // Listeners are on window so the drag survives the pointer leaving
      // the 6px handle hit-area (real-world dragging immediately moves
      // off the handle as the column resizes).
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  // Defense-in-depth: ensure documentElement class is cleaned on unmount.
  onCleanup(() => {
    document.documentElement.classList.remove("resize-dragging");
  });

  // Restore stored value on mount so the column reflects the persisted
  // width even before the user drags. (main.tsx's
  // applySidebarWidthsFromStorage handles this on cold load; this is a
  // safety net for hot-reload paths that don't re-run main.tsx.)
  //
  // issue 1827 — ONLY when there is a stored value. This used to write the
  // var unconditionally, which defeated every per-tier CSS default exactly
  // the way the boot call did; a handle that has never been dragged must
  // leave the stylesheet's own fallback standing.
  const stored = getStoredSidebarWidth(props.side);
  if (stored !== null) {
    document.documentElement.style.setProperty(CSS_VAR[props.side], `${stored}px`);
  }

  // aria-valuenow tracks the current width so screen readers announce
  // the size change as the operator drags. role="separator" with
  // aria-orientation="vertical" requires valuenow/min/max for the
  // resizable-separator pattern (ARIA 1.2 §6.6.16).
  //
  // issue 1827 — measure the owning aside rather than re-deriving from
  // storage. With the per-tier default now living in CSS, storage does not
  // know what a never-dragged rail renders at (8rem in the short-landscape
  // tier, 16rem on the desktop shell), so deriving would announce a width
  // the operator is not looking at. The rect is the resolved grid track,
  // whichever arm produced it; the storage read stays as the fallback for
  // pre-layout mounts, where the rect is 0.
  const ariaValueNow = () => {
    const measured = handleEl?.parentElement?.getBoundingClientRect().width ?? 0;
    return measured > 0 ? Math.round(measured) : getSidebarWidth(props.side);
  };

  return (
    // <hr> can't host pointer-drag interaction or custom CSS sizing;
    // role="separator" + valuenow/min/max is the canonical ARIA 1.2
    // resizable-separator pattern (§6.6.16).
    // biome-ignore lint/a11y/useSemanticElements: see comment above
    <div
      ref={handleEl}
      class="resize-handle"
      classList={{
        "resize-handle-left": props.side === "left",
        "resize-handle-right": props.side === "right",
      }}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={props.side === "left" ? "Resize sidebar" : "Resize members pane"}
      aria-valuenow={ariaValueNow()}
      aria-valuemin={minWidthPx()}
      aria-valuemax={maxWidthPx()}
      onPointerDown={onPointerDown}
    />
  );
};

export default ResizeHandle;
