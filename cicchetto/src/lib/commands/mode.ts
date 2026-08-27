import { ownNickForNetwork } from "../api";
import { openBanlistModal } from "../banlistModal";
import { isChannelName } from "../chantypes";
import { type IsupportEntry, isupportForNetwork } from "../isupport";
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
// letter is a LIST on this NETWORK (`isupport.chanmodes.a`, server-published
// — cic never derives it).
//
// Why it is not in the pure parser: those conditions are 005 data.
// `/mode #chan +i` on a network where `i` is a flag must stay a mode change,
// and no letter is a list mode everywhere — `q` is a LIST on solanum and a
// founder-status prefix elsewhere.
//
// issue 1831 — the answer is a THREE-way split, not two, because "not a list
// query" and "a list query grappa cannot answer" are different facts:
//
//   * `execute`    — put the MODE on the wire verbatim. A mask makes it a
//                    mutation; so does any letter this network does not class
//                    as type A (`/mode #chan m` sets +m and echoes back).
//   * `query`      — a type-A letter grappa knows the reply numerics for
//                    (`listModesQueryable`, server-side `ListModes.known?/1`):
//                    open the list modal and re-query.
//   * `unreadable` — a type-A letter grappa has NO numeric pair for. The ircd
//                    would stream the list happily; nothing here is primed to
//                    collect it.
//
// The third arm used to fold into the first, which put a raw
// `MODE #chan <letter>` on the wire and returned `{ok: true}`: no modal, no
// error, no rows — a silent swallow at a boundary (CLAUDE.md), and one the
// operator cannot tell apart from the command never having run.
type ListModeIntent =
  | { kind: "execute" }
  | { kind: "query"; letter: string }
  | { kind: "unreadable"; letter: string };

// Takes the capability table as DATA, like `isChannelName` takes the sigils:
// the caller has already resolved it, and passing it keeps this a pure
// classification of one typed line.
const listModeIntent = (
  modes: string,
  params: string[],
  isupport: IsupportEntry,
): ListModeIntent => {
  if (params.length > 0) return { kind: "execute" };
  const letter = /^[+-]?([A-Za-z])$/.exec(modes)?.[1];
  if (letter === undefined) return { kind: "execute" };
  if (isupport.listModesQueryable.includes(letter)) return { kind: "query", letter };
  return isupport.chanmodes.a.includes(letter)
    ? { kind: "unreadable", letter }
    : { kind: "execute" };
};

/**
 * The one message every "I cannot show you that list" arm reads from —
 * `/banlist <letter>`, `/mode #chan <letter>` and `/mode <letter>`. #1251
 * ruled those spellings must behave alike, and the WORDING is part of alike.
 *
 * Two different truths, and conflating them sends the operator after a cause
 * that is not there: a letter this network never advertised as type A HAS no
 * list here, while a letter it does advertise and grappa has no numeric pair
 * for is grappa's limit, not the network's. Both name the set that IS
 * available, which is the only actionable half.
 */
const noListMessage = (verb: string, letter: string, isupport: IsupportEntry): string => {
  const offered = isupport.listModesQueryable;
  const available =
    offered.length > 0 ? `it offers ${offered.map((m) => `+${m}`).join(" ")}` : "it offers none";
  const cause = isupport.chanmodes.a.includes(letter)
    ? `grappa can't read this network's +${letter} list`
    : `this network has no +${letter} list`;
  return `/${verb}: ${cause} (${available})`;
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
  // server-published, never derived. issue 1831 — the wording is shared with
  // the two `/mode` spellings of the same question.
  const isupport = isupportForNetwork(networkId);
  if (!isupport.listModesQueryable.includes(cmd.mode)) {
    return { error: noListMessage("banlist", cmd.mode, isupport) };
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
  //
  // The sigil test stays here, and is NOT the duplicated derivation issue 1831
  // removed from `getActiveChannel`: the parser emits `{kind: "mode"}` from
  // BOTH its channel branch and its nick branch (`/mode alice +o` is a user
  // MODE), so `cmd.target` is a token whose class nothing upstream has fixed.
  // Only a CHANNEL has type-A lists.
  //
  // The `intent.kind !== "execute"` conjunct comes FIRST so `ctx.sigils()`
  // stays unevaluated on the ordinary mutation path — the same laziness #1396
  // pins for `requireNetworkId`, and the `#1396` effect snapshot fails if this
  // arm starts resolving a network id it does not need.
  const isupport = isupportForNetwork(networkId);
  const intent = listModeIntent(cmd.modes, cmd.params, isupport);
  if (intent.kind !== "execute" && isChannelName(cmd.target, ctx.sigils())) {
    // issue 1831 — say so rather than firing a frame nobody hears.
    if (intent.kind === "unreadable") {
      return { error: noListMessage("mode", intent.letter, isupport) };
    }
    openBanlistModal(ctx.networkSlug, cmd.target, intent.letter);
    pushChannelBanlist(networkId, cmd.target, intent.letter);
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
  // above; `/mode +b` and `/mode #chan +b` must behave alike. No sigil test:
  // the target here IS the current channel window, already resolved.
  const isupport = isupportForNetwork(networkId);
  const intent = listModeIntent(cmd.modes, cmd.params, isupport);
  if (intent.kind === "unreadable") {
    return { error: noListMessage("mode", intent.letter, isupport) };
  }
  if (intent.kind === "query") {
    openBanlistModal(ctx.networkSlug, chanOrErr, intent.letter);
    pushChannelBanlist(networkId, chanOrErr, intent.letter);
    return { ok: true };
  }
  await pushChannelMode(networkId, chanOrErr, cmd.modes, cmd.params);
  return { ok: true };
};
