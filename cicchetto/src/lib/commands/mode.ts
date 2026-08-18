import { ownNickForNetwork } from "../api";
import { openBanlistModal } from "../banlistModal";
import { isChannelName } from "../chantypes";
import { isupportForNetwork } from "../isupport";
import { openModeModal } from "../modeModal";
import { networkBySlug, user } from "../networks";
import { nickEquals } from "../nickEquals";
import { pushChannelBanlist, pushChannelMode, pushChannelUmode } from "../socket";
import { openUmodeModal } from "../umodeModal";
import type { CommandHandler } from "./context";

/**
 * The mode family: channel modes, user modes, and the list-mode surfaces they
 * share. `/banlist` lives here rather than with the operator verbs because it
 * is a type-A list QUERY — the same modal-plus-requery pair `/mode #chan +b`
 * opens, reached by a different spelling.
 */

// #536/#1251 — is this `/mode` a type-A LIST QUERY rather than a mode change?
// Three conditions, all necessary: no parameter (a mask makes it a MUTATION,
// `/mode #chan +b nick!*@*`), exactly one optionally-signed letter, and that
// letter is one this NETWORK offers as a queryable list (server-published, in
// `isupport.listModesQueryable` — cic never derives it).
//
// Why it is not in the pure parser: the third condition is 005 data.
// `/mode #chan +i` on a network where `i` is a flag must stay a mode change,
// and no letter is a list mode everywhere — `q` is a LIST on solanum and a
// founder-status prefix elsewhere. Returns the bare letter, or null when the
// caller should execute the MODE verbatim.
const listModeQueryLetter = (modes: string, params: string[], networkId: number): string | null => {
  if (params.length > 0) return null;
  const letter = /^[+-]?([A-Za-z])$/.exec(modes)?.[1];
  if (letter === undefined) return null;
  return isupportForNetwork(networkId).listModesQueryable.includes(letter) ? letter : null;
};

/**
 * #386 — `/banlist` is the channel list-mode MODAL surface (it supersedes the
 * #376 inline BanlistCard, mirroring how the #169 /who modal replaced the
 * inline WHO dump). Open the modal AND fire a fresh re-query so the list is
 * live on open (pre-#386 it was fire-and-forget only).
 *
 * An explicit `/banlist #chan` resolves in the parser; a bare `/banlist`
 * carries null → the current channel (same resolver every channel-scoped verb
 * uses).
 */
export const banlistCommand: CommandHandler<"banlist"> = async (cmd, ctx) => {
  const chanOrErr = cmd.channel ?? ctx.requireChannel("banlist");
  if (typeof chanOrErr !== "string") return chanOrErr;
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "banlist");
  if (typeof networkId !== "number") return networkId;
  // #1251 — an explicitly typed letter this network cannot answer is an ERROR,
  // not a silent fallback to bans: the operator asked for a specific list and
  // would otherwise read the ban list as the exempt list. The offered set is
  // server-published, never derived.
  const offered = isupportForNetwork(networkId).listModesQueryable;
  if (!offered.includes(cmd.mode)) {
    return {
      error: `/banlist: this network has no +${cmd.mode} list (it offers ${offered.map((m) => `+${m}`).join(" ")})`,
    };
  }
  openBanlistModal(ctx.networkSlug, chanOrErr, cmd.mode);
  pushChannelBanlist(networkId, chanOrErr, cmd.mode);
  return { ok: true };
};

/** `/umode <modes>` — user-mode on own nick, no channel context required. */
export const umodeCommand: CommandHandler<"umode"> = async (cmd, ctx) => {
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "umode");
  if (typeof networkId !== "number") return networkId;
  await pushChannelUmode(networkId, cmd.modes);
  return { ok: true };
};

/**
 * #229 — bare `/umode`: open the umode viewer/editor modal for the active
 * window's network. Umodes are per-session (no channel context needed), so any
 * window kind can open it.
 */
export const umodeViewCommand: CommandHandler<"umode-view"> = async (_cmd, ctx) => {
  openUmodeModal(ctx.networkSlug);
  return { ok: true };
};

/**
 * #229 — `/mode <nick>` with no mode args. Open the umode modal ONLY when the
 * target resolves to the operator's OWN nick (the modal edits your own umodes;
 * there is no viewer for another user's). Resolve via `ownNickForNetwork`
 * (visitor → me.nick; user → per-credential net.nick) — the same canonical
 * resolver the /whois self-default uses; `nickEquals` for the
 * case-insensitive compare (ASCII, #121/#525). A non-self target is a friendly
 * error rather than a phantom modal.
 */
export const umodeTargetViewCommand: CommandHandler<"umode-target-view"> = async (cmd, ctx) => {
  const net = networkBySlug(ctx.networkSlug);
  const own = net ? ownNickForNetwork(net, user()) : null;
  if (own && nickEquals(cmd.target, own)) {
    openUmodeModal(ctx.networkSlug);
    return { ok: true };
  }
  return {
    error: `/mode ${cmd.target}: viewing another user's modes isn't supported — use /mode <#channel> for a channel, or /mode ${own ?? "<yournick>"} for your own user modes`,
  };
};

/**
 * `/mode <#chan> <modes> [params]` — execute directly, raw verbatim, target
 * explicit in args. No modal, no channel-window requirement (#216: mode-args
 * present → apply).
 */
export const modeCommand: CommandHandler<"mode"> = async (cmd, ctx) => {
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "mode");
  if (typeof networkId !== "number") return networkId;
  // #536/#1251 — a bare list letter with NO mask is a QUERY, not a mutation:
  // open the list modal instead of putting a raw MODE on the wire whose reply
  // rows nothing is primed to collect.
  const listMode = listModeQueryLetter(cmd.modes, cmd.params, networkId);
  if (listMode !== null && isChannelName(cmd.target, ctx.sigils())) {
    openBanlistModal(ctx.networkSlug, cmd.target, listMode);
    pushChannelBanlist(networkId, cmd.target, listMode);
    return { ok: true };
  }
  await pushChannelMode(networkId, cmd.target, cmd.modes, cmd.params);
  return { ok: true };
};

/**
 * #216 — no mode-args: open the viewer/editor modal. Explicit `/mode #chan`
 * targets that channel; bare `/mode` targets the current channel window (error
 * if not in one — the same resolver every channel-scoped verb uses).
 */
export const modeViewCommand: CommandHandler<"mode-view"> = async (cmd, ctx) => {
  const ch = cmd.channel ?? ctx.getActiveChannel();
  if (!ch) return { error: "/mode requires a channel — switch to one or use /mode #chan" };
  openModeModal(ctx.networkSlug, ch);
  return { ok: true };
};

/**
 * #216 — `/mode +s` (mode string, no channel token) applies to the current
 * channel. Mode-args present → execute directly, no modal; requires a channel
 * window.
 */
export const modeApplyCurrentCommand: CommandHandler<"mode-apply-current"> = async (cmd, ctx) => {
  const chanOrErr = ctx.requireChannel("mode");
  if (typeof chanOrErr !== "string") return chanOrErr;
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "mode");
  if (typeof networkId !== "number") return networkId;
  // #536/#1251 — same list-QUERY interception as the explicit-channel arm
  // above; `/mode +b` and `/mode #chan +b` must behave alike.
  const listMode = listModeQueryLetter(cmd.modes, cmd.params, networkId);
  if (listMode !== null) {
    openBanlistModal(ctx.networkSlug, chanOrErr, listMode);
    pushChannelBanlist(networkId, chanOrErr, listMode);
    return { ok: true };
  }
  await pushChannelMode(networkId, chanOrErr, cmd.modes, cmd.params);
  return { ok: true };
};
