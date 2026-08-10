import type { Component } from "solid-js";
import ContextMenu, { type ContextMenuAction, type ContextMenuItem } from "./ContextMenu";
import { sendCtcpQuery } from "./lib/ctcpQuery";
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
// The chrome (portal, backdrop, Escape, the #487 measured viewport clamp) lives
// in `ContextMenu`, shared since #1067 added the long-press message menu. This
// module is now only the item list.
//
// #1192 added a ninth entry: a CTCP group that drills down rather than six more
// rows on a menu that already has eight.

// #1192 — the verbs worth a menu row. Small and closed on purpose: `/ctcp` is
// still there for anything else, and every entry here costs a row on a menu
// that a thumb has to hit.
//
// Neither VERSION nor CLIENTINFO is verifiable — both are strings the remote
// client picks for itself (CLIENTINFO is the verbs it claims to answer, which
// is capability discovery, not identity). They are worth asking; they are not
// worth believing.
const CTCP_VERBS = ["VERSION", "TIME", "PING", "CLIENTINFO", "USERINFO", "SOURCE"] as const;

export type Props = {
  networkSlug: string;
  networkId: number;
  channelName: string;
  targetNick: string;
  ownModes: string[];
  position: { x: number; y: number };
  onClose: () => void;
};

const UserContextMenu: Component<Props> = (props) => {
  const isOp = (): boolean => props.ownModes.includes("@");

  // Every verb dispatches identically — the seam owns the #640 source-window
  // echo and the #600 register-before-send ordering, so there is nothing here
  // for PING to special-case. Args are empty: a menu row has no place to type
  // one, and a BARE ping is what correlates through the #637 token-less
  // fallback without the seam inventing wire bytes.
  //
  // Detached, because a menu item's action is synchronous and this menu has no
  // inline error channel the way the composer does. Never bare, though: an
  // unhandled rejection is how a throttled or WS-down probe becomes a row that
  // simply never appears. Same shape as compose.ts's detached fan-out — a
  // grep key and the reason it stopped.
  const ctcpItems = (): ContextMenuAction[] =>
    CTCP_VERBS.map((verb) => ({
      label: verb,
      enabled: true,
      action: (): void => {
        void sendCtcpQuery({
          networkSlug: props.networkSlug,
          networkId: props.networkId,
          sourceChannel: props.channelName,
          targetNick: props.targetNick,
          verb,
          args: "",
          sentAtMs: Date.now(),
        }).catch((err: unknown) => {
          console.warn(`[ctcp-menu] ${verb} to ${props.targetNick} never left:`, err);
        });
      },
    }));

  const items = (): ContextMenuItem[] => [
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
      // #1192 — sits between WHOIS and Query because it belongs with WHOIS:
      // both interrogate the person, while Query talks to them. Always enabled,
      // like its neighbours — asking a peer for its VERSION needs no channel
      // privilege.
      label: "CTCP",
      enabled: true,
      submenu: ctcpItems(),
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

  return <ContextMenu items={items()} position={props.position} onClose={props.onClose} />;
};

export default UserContextMenu;
