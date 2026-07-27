import { type Component, createEffect, createSignal, For, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { computeMenuPosition } from "./lib/menuPosition";
import { canonicalQueryNick, openQueryWindowState } from "./lib/queryWindows";
import { setSelectedChannel } from "./lib/selection";
import {
  pushChannelBan,
  pushChannelDeop,
  pushChannelDevoice,
  pushChannelKick,
  pushChannelOp,
  pushChannelVoice,
  pushWhois,
} from "./lib/socket";

// Right-click context menu for member-list nicks (spec #3, C5.1).
//
// Renders 8 items: op / deop / voice / devoice / kick / ban (all gated on
// own-nick @ mode, disabled-but-NOT-hidden when unmet) + WHOIS + Query
// (always enabled, no perm required).
//
// Dispatches to existing socket.ts push helpers — no new IRC-issuance path.
// Ban mask uses the `nick!*@*` fallback (WHOIS-cache mask derivation is
// deferred per spec #3 note; see commit body for gap flag).
//
// Positioning (#487): measured flip/clamp so the menu always opens fully
// inside the viewport. After render we measure the menu box
// (getBoundingClientRect) and feed it + window.innerWidth/innerHeight to the
// pure `computeMenuPosition` seam (lib/menuPosition.ts): the menu FLIPS above/
// left of the click when it would overflow the far edge (pointer stays on the
// menu edge, like a native context menu), CLAMPS when a flip would underflow,
// and pins to the edge — with the CSS `max-height` + `overflow-y:auto` fallback
// below — when it is taller than the viewport (short mobile viewport, keyboard
// up). The arithmetic is unit-tested without a real viewport
// (menuPosition.test.ts); the visible placement is proven in the Playwright
// e2e (issue487-context-menu-viewport-clamp.spec.ts) since jsdom gives no real
// viewport dimensions. Opacity-gated until measured so the pre-measure frame
// never flashes off-screen.
//
// Close: backdrop click OR Escape keydown fires `onClose`.

export type Props = {
  networkSlug: string;
  networkId: number;
  channelName: string;
  targetNick: string;
  ownModes: string[];
  position: { x: number; y: number };
  onClose: () => void;
};

type MenuItem = {
  label: string;
  enabled: boolean;
  action: () => void;
};

const UserContextMenu: Component<Props> = (props) => {
  const isOp = (): boolean => props.ownModes.includes("@");

  const items = (): MenuItem[] => [
    {
      label: "Op",
      enabled: isOp(),
      action: () => pushChannelOp(props.networkId, props.channelName, [props.targetNick]),
    },
    {
      label: "Deop",
      enabled: isOp(),
      action: () => pushChannelDeop(props.networkId, props.channelName, [props.targetNick]),
    },
    {
      label: "Voice",
      enabled: isOp(),
      action: () => pushChannelVoice(props.networkId, props.channelName, [props.targetNick]),
    },
    {
      label: "Devoice",
      enabled: isOp(),
      action: () => pushChannelDevoice(props.networkId, props.channelName, [props.targetNick]),
    },
    {
      label: "Kick",
      // Bare KICK, no reason input prompt in C5.1.
      enabled: isOp(),
      action: () => pushChannelKick(props.networkId, props.channelName, props.targetNick, ""),
    },
    {
      label: "Ban",
      // Fallback mask: nick!*@*. WHOIS-cache mask derivation deferred (spec #3 gap).
      enabled: isOp(),
      action: () => pushChannelBan(props.networkId, props.channelName, `${props.targetNick}!*@*`),
    },
    {
      label: "WHOIS",
      // Always enabled — no perm required.
      enabled: true,
      action: () => pushWhois(props.networkId, props.targetNick, null),
    },
    {
      label: "Query",
      // Always enabled — no perm required. Opens DM window + switches focus.
      // canonicalQueryNick wraps to keep focus on an existing
      // case-insensitive match (RFC 2812 §2.2 — IRC nicks are
      // case-insensitive).
      enabled: true,
      action: () => {
        const canonical = canonicalQueryNick(props.networkId, props.targetNick);
        openQueryWindowState(props.networkId, canonical, new Date().toISOString());
        setSelectedChannel({
          networkSlug: props.networkSlug,
          channelName: canonical,
          kind: "query",
        });
      },
    },
  ];

  // Escape key closes the menu.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") props.onClose();
  };

  createEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  const handleItemClick = (item: MenuItem): void => {
    if (!item.enabled) return;
    item.action();
    props.onClose();
  };

  // #487 — measured viewport clamp/flip. Start at the raw click point, then
  // correct once the rendered menu box can be measured. `createEffect` (not
  // `onMount`) re-measures + repositions when `props.position` changes — a
  // right-click on another nick while the menu is still open reuses this
  // component (MembersPane's <Show> keeps it mounted), so onMount alone would
  // strand the menu at the first click's coords. Opacity-gated so the
  // pre-measure frame never flashes off-screen at the raw click point.
  let menuRef: HTMLDivElement | undefined;
  const [placement, setPlacement] = createSignal({
    top: props.position.y,
    left: props.position.x,
  });
  const [placed, setPlaced] = createSignal(false);

  createEffect(() => {
    // Track the click position so a re-open at new coords re-runs this.
    const clickX = props.position.x;
    const clickY = props.position.y;
    if (!menuRef) return;
    const rect = menuRef.getBoundingClientRect();
    setPlacement(
      computeMenuPosition({
        clickX,
        clickY,
        menuWidth: rect.width,
        menuHeight: rect.height,
        // Visual viewport (NOT window.innerWidth/Height) so the clamp shrinks
        // with the on-screen keyboard — matching the CSS `max-height:
        // var(--viewport-height)` fallback below and the app-wide
        // viewportHeight.ts primitive (both derive from window.visualViewport).
        // window.innerHeight stays full-screen while the keyboard is up, which
        // would let the menu render under the keyboard (the #487 symptom, on
        // mobile). Playwright equalizes innerHeight and visualViewport, so the
        // keyboard-up divergence is a device-dogfood item, not an e2e one.
        viewportWidth: window.visualViewport?.width ?? window.innerWidth,
        viewportHeight: window.visualViewport?.height ?? window.innerHeight,
      }),
    );
    setPlaced(true);
  });

  return (
    // Portal to <body> so the fixed-position menu + backdrop are never
    // trapped inside a scrollback-pane stacking context. #75's background
    // wallpaper makes `.scrollback-pane` an `isolation: isolate` stacking
    // context when a bg theme is active; a fixed descendant of it would be
    // confined to the pane's paint region (menu behind the ComposeBox,
    // backdrop not covering out-of-pane chrome). Rendering at the document
    // root keeps the z-300/301 layers above everything, themed or not.
    <Portal>
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
        <For each={items()}>
          {(item) => (
            <button
              type="button"
              class="context-menu-item"
              classList={{ "context-menu-item-disabled": !item.enabled }}
              disabled={!item.enabled}
              onClick={() => handleItemClick(item)}
            >
              {item.label}
            </button>
          )}
        </For>
      </div>
    </Portal>
  );
};

export default UserContextMenu;
