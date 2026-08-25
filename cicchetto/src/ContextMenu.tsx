import { type Component, createEffect, createSignal, For, on, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { computeMenuPosition } from "./lib/menuPosition";
import { createOverlayEscape } from "./lib/overlayScrollLock";

// The context-menu SHELL: portal, backdrop, Escape, and the measured
// flip/clamp placement. Extracted from `UserContextMenu` when #1067 needed a
// second menu (the long-press message menu) with the same chrome and a
// completely different item list — the shared thing is the frame, not the
// actions, so the caller supplies the items.
//
// Positioning (#487): measured flip/clamp so the menu always opens fully inside
// the viewport. After render we measure the menu box (getBoundingClientRect)
// and feed it + the viewport to the pure `computeMenuPosition` seam
// (lib/menuPosition.ts): the menu FLIPS above/left of the press when it would
// overflow the far edge (pointer stays on the menu edge, like a native context
// menu), CLAMPS when a flip would underflow, and pins to the edge — with the
// CSS `max-height` + `overflow-y:auto` fallback — when it is taller than the
// viewport (short mobile viewport, keyboard up). The arithmetic is unit-tested
// without a real viewport (menuPosition.test.ts); the visible placement is
// proven in the Playwright e2e (issue487-context-menu-viewport-clamp.spec.ts)
// since jsdom gives no real viewport dimensions. Opacity-gated until measured
// so the pre-measure frame never flashes off-screen.
//
// #949 — "inside the viewport" was the LAYOUT viewport, whose origin under
// `viewport-fit=cover` is the physical top of the display. #913 fixed the same
// arithmetic for the rail menu and named this door as carrying the residue.
// The bounds now come from `.context-menu-safe-area`: a fixed, unpainted box
// laid out at `inset: env(safe-area-inset-*)`, measured with
// `getBoundingClientRect()`. That indirection is the point. #913 established
// that JS must NOT read the inset back out of a custom property —
// `getComputedStyle().getPropertyValue()` on an unregistered one can hand back
// the token stream rather than a length, and the NaN that follows is swallowed
// by any `|| 0` into a fix that looks applied and does nothing. A rect is a
// resolved length by construction: the engine still owns `env()`, and JS reads
// geometry, which is the one thing it can always trust. The box also yields
// all four insets from one measurement, which is what the X axis (landscape
// notch) and the bottom edge (home indicator) need.

// An item either DOES something or OPENS something, never both — so the two
// are separate shapes rather than one shape with an optional field, and
// `"submenu" in item` narrows exhaustively.
//
// #1192 — a submenu holds ACTIONS ONLY, so nesting is impossible by
// construction. That is not a limitation to lift later: the drill state below
// is a single index into `props.items`, which is what keeps it from going stale
// when the caller re-renders the list. Depth would need a path, and nothing
// wants depth.
export type ContextMenuAction = {
  label: string;
  enabled: boolean;
  action: () => void;
};

export type ContextMenuItem =
  | ContextMenuAction
  | { label: string; enabled: boolean; submenu: ContextMenuAction[] };

export type Props = {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
};

const ContextMenu: Component<Props> = (props) => {
  // #1411 — Escape goes through the ONE shared ESC stack (#232), not a private
  // `document` listener. The private one was a second global ESC authority,
  // which is the exact thing #232 deleted `MediaViewerModal`'s copy to prevent:
  // it closed the menu and left the stack empty, so the SAME keypress fell
  // through `keybindings.ts` to `closeDrawer()` — on a phone, where MembersPane
  // IS the members drawer, a long-press menu and its drawer went together.
  // Stack membership also gives the menu LIFO precedence, so a modal opened
  // over it closes first.
  //
  // The NO-FREEZE variant (#1199), not `createOverlayLock`: the menu floats at
  // fixed coordinates over a pane that stays live behind it, so taking a
  // COVERING refcount would freeze the scrollback snapshot for the life of a
  // long-press. The predicate is the constant `true` because all three hosts
  // mount this component behind a `<Show>` on their own open state.
  //
  // #1772 — it does take the iOS touch lock, which this helper now carries on
  // the other side of that split. It did not, and the shell panned under an
  // open menu: `.context-menu-backdrop` is `position: fixed; inset: 0`, which
  // reads like a shield but only ever intercepted CLICKS, so a DRAG went to
  // UIKit as a page pan while the menu itself — `position: fixed` — stayed put
  // and the content slid out from under it. The stylesheet half (backdrop
  // claims the stream, menu re-opens its own pan) is in `default.css`.
  createOverlayEscape(
    () => true,
    () => props.onClose(),
  );

  // #1192 — the drill-down level, held as an INDEX into `props.items` rather
  // than as the submenu object itself. The caller rebuilds its item array on
  // every access (a JSX prop is a getter, and `UserContextMenu` calls `items()`
  // inline), so a captured object would go stale the moment anything upstream
  // re-rendered; an index is re-resolved against the current props every read.
  const [drilledIndex, setDrilledIndex] = createSignal<number | null>(null);

  const drilled = (): ContextMenuAction[] | null => {
    const index = drilledIndex();
    if (index === null) return null;
    const item = props.items[index];
    return item !== undefined && "submenu" in item ? item.submenu : null;
  };

  const visibleItems = (): ContextMenuItem[] => drilled() ?? props.items;

  // The parent's own label, shown on the back row so the drilled level says
  // where it is as well as how to leave.
  const drilledLabel = (): string => {
    const index = drilledIndex();
    return index === null ? "" : (props.items[index]?.label ?? "");
  };

  // A second open can reuse this component instance: both call sites gate on a
  // `<Show>` whose signal goes value→value when the operator right-clicks a
  // different nick while the menu is up, so nothing unmounts. The placement
  // effect already has to re-run for that case; the drill level has to RESET for
  // it, or the second nick opens straight into the first one's submenu.
  createEffect(
    on(
      () => [props.position.x, props.position.y],
      () => setDrilledIndex(null),
      { defer: true },
    ),
  );

  const handleItemClick = (item: ContextMenuItem, index: number): void => {
    if (!item.enabled) return;
    if ("submenu" in item) {
      setDrilledIndex(index);
      return;
    }
    item.action();
    props.onClose();
  };

  let menuRef: HTMLDivElement | undefined;
  let safeAreaRef: HTMLDivElement | undefined;
  const [placement, setPlacement] = createSignal({
    top: props.position.y,
    left: props.position.x,
  });
  const [placed, setPlaced] = createSignal(false);

  createEffect(() => {
    // Track the press position so a re-open at new coords re-runs this: the
    // caller may keep this component mounted across two opens (`<Show>` on a
    // signal), so `onMount` alone would strand the menu at the first coords.
    const clickX = props.position.x;
    const clickY = props.position.y;
    // #1192 — and track the drill level for the same reason: entering or
    // leaving a submenu swaps the item list, so the box changes HEIGHT. Without
    // this read the menu keeps the placement measured for the previous level,
    // and a submenu opened near the bottom edge hangs off the fold — the exact
    // #487 defect, re-entered through a door #487 could not have known about.
    drilledIndex();
    if (!menuRef || !safeAreaRef) return;
    const rect = menuRef.getBoundingClientRect();
    const safe = safeAreaRef.getBoundingClientRect();
    setPlacement(
      computeMenuPosition({
        clickX,
        clickY,
        menuWidth: rect.width,
        menuHeight: rect.height,
        // Visual viewport (NOT window.innerWidth/Height) so the clamp shrinks
        // with the on-screen keyboard — matching the CSS `max-height:
        // var(--viewport-height)` fallback and the app-wide viewportHeight.ts
        // primitive (both derive from window.visualViewport).
        // window.innerHeight stays full-screen while the keyboard is up, which
        // would let the menu render under the keyboard (the #487 symptom, on
        // mobile). Playwright equalizes innerHeight and visualViewport, so the
        // keyboard-up divergence is a device-dogfood item, not an e2e one.
        viewportWidth: window.visualViewport?.width ?? window.innerWidth,
        viewportHeight: window.visualViewport?.height ?? window.innerHeight,
        // #949 — the safe box, in layout-viewport coordinates. Where there is
        // no inset (every desktop browser, every engine in the e2e suite) this
        // is exactly {0, w, h, 0} and the placement is bit-identical to #487's.
        safeArea: { top: safe.top, right: safe.right, bottom: safe.bottom, left: safe.left },
      }),
    );
    setPlaced(true);
  });

  return (
    // Portal to <body> so the fixed-position menu + backdrop are never trapped
    // inside a scrollback-pane stacking context. #75's background wallpaper
    // makes `.scrollback-pane` an `isolation: isolate` stacking context when a
    // bg theme is active; a fixed descendant of it would be confined to the
    // pane's paint region (menu behind the ComposeBox, backdrop not covering
    // out-of-pane chrome). Rendering at the document root keeps the z-300/301
    // layers above everything, themed or not.
    <Portal>
      {/* #949 — the safe-area ruler. Unpainted and untouchable; it exists only
          so `getBoundingClientRect()` can hand the placement math the four
          insets as resolved lengths. */}
      <div ref={safeAreaRef} class="context-menu-safe-area" aria-hidden="true" />
      {/* Backdrop: click-outside closes the menu. Rendered as button for a11y. */}
      <button
        type="button"
        class="context-menu-backdrop"
        aria-label="Close menu"
        onClick={props.onClose}
      />
      <div
        ref={menuRef}
        class="context-menu"
        style={{
          position: "fixed",
          top: `${placement().top}px`,
          left: `${placement().left}px`,
          opacity: placed() ? "1" : "0",
        }}
        role="menu"
      >
        {/* #1192 — the way back UP a drill-down. Deliberately a peer of the
            items (same `.context-menu-item` class, so it inherits the hit
            target and the e2e's locator) rather than a floating chrome
            affordance: on a long-press menu there is nowhere to put chrome, and
            a row is the one thing a thumb already knows how to hit. Escape is
            left alone — it still closes the whole menu, the behaviour every
            existing caller of this shell already has. */}
        <Show when={drilled()}>
          <button
            type="button"
            class="context-menu-item context-menu-back"
            onClick={() => setDrilledIndex(null)}
          >
            ‹ {drilledLabel()}
          </button>
        </Show>
        <For each={visibleItems()}>
          {(item, index) => (
            <button
              type="button"
              class="context-menu-item"
              classList={{ "context-menu-item-disabled": !item.enabled }}
              disabled={!item.enabled}
              onClick={() => handleItemClick(item, index())}
            >
              {/* The ▸ is the shell's job, not the caller's: the caller names
                  the group, the shell says it opens. */}
              {"submenu" in item ? `${item.label} ▸` : item.label}
            </button>
          )}
        </For>
      </div>
    </Portal>
  );
};

export default ContextMenu;
