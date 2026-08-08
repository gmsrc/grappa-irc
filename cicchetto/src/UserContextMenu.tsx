import type { Component } from "solid-js";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
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
