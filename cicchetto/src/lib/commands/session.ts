import { patchNetwork, postNick, postNotifyAdd } from "../api";
import { friendlyError } from "../friendlyError";
import { clearMentionsBundle } from "../mentionsWindow";
import { quitAll } from "../quit";
import { pushAwaySet, pushAwayUnset, pushOper, pushRecover } from "../socket";
import type { CommandHandler } from "./context";

/**
 * `/quit [reason]` — nuclear: park ALL bound networks, then logout. The
 * implementation lives in `lib/quit.ts` so the sidebar server-window ×
 * (UX-4 bucket D) can call the same path for visitors without re-parsing
 * through here.
 *
 * After logout the component tree unmounts, so nothing downstream of this
 * outcome runs.
 */
export const quitCommand: CommandHandler<"quit"> = async (cmd) => {
  await quitAll(cmd.reason);
  return { ok: true };
};

/**
 * `/disconnect [network] [reason]` — surgical: park ONE network. `network` from
 * the parser is null (bare /disconnect) or a named slug; null means the active
 * window's.
 */
export const disconnectCommand: CommandHandler<"disconnect"> = async (cmd, ctx) => {
  const targetSlug = cmd.network ?? ctx.networkSlug;
  const body: { connection_state: "parked"; reason?: string } = { connection_state: "parked" };
  if (cmd.reason !== null) body.reason = cmd.reason;
  await patchNetwork(ctx.token, targetSlug, body);
  return { ok: true };
};

/**
 * S3.4 — explicit away set/unset via the user-level Phoenix Channel. The push
 * reaches GrappaChannel.handle_in("away", …) which routes to
 * Session.set_explicit_away / unset_explicit_away.
 *
 * #268 — the going-away arm clears THIS network's stale mentions bundle here,
 * on the user's own action, NOT on the `away_confirmed:"away"` echo. The clear
 * MUST be causally ordered with the away lifecycle: the return-from-away
 * `mentions_bundle` is broadcast SYNCHRONOUSLY by grappa on the un-away
 * command, but `away_confirmed` is emitted only on the upstream 305/306 numeric
 * echo (event_router.ex) — a different-latency channel. Under bahamut fake-lag
 * a going-away's delayed 306 could arrive AFTER a subsequent return's bundle
 * and clobber it (the "0 messages in 0 channels" bug). Triggering the clear on
 * the compose action makes it ordered with the user's own commands, so a fresh
 * bundle set on RETURN can never be wiped by a stale echo. The mentions bundle
 * is a client-ephemeral render store (not server-mirrored window/away state),
 * so clearing it on a user action does not violate the "cic never originates
 * state" invariant. Tradeoff: auto-away / cross-device going-away (no compose)
 * no longer clear, so a stale bundle can linger IF the next return carries zero
 * new mentions (the server suppresses the empty broadcast) — a timestamped,
 * secondary-button digest, strictly less harmful than the fresh-bundle-wipe it
 * replaces. A robust auto-away clear would need a server sync-broadcast (out of
 * the "lato client" scope). See docs/DESIGN_NOTES.md 2026-07-16.
 */
export const awayCommand: CommandHandler<"away"> = async (cmd, ctx) => {
  if (cmd.action === "set") {
    clearMentionsBundle(ctx.networkSlug);
    await pushAwaySet(ctx.networkSlug, cmd.reason);
  } else {
    await pushAwayUnset(ctx.networkSlug);
  }
  return { ok: true };
};

/** `/nick <nick>` — rename on this network, over REST (addressed by SLUG). */
export const nickCommand: CommandHandler<"nick"> = async (cmd, ctx) => {
  await postNick(ctx.token, ctx.networkSlug, cmd.nick);
  return { ok: true };
};

/**
 * #581 — `/recover [network]`: guided "recover my identity". The server runs
 * the NickServ recovery sequence and streams recover_progress / recover_result
 * events on the user topic (RecoverModal mirrors them). The modal opens off the
 * SERVER's first recover_progress — NOT optimistically here (cic never
 * originates state). Bare /recover uses the active window's network.
 */
export const recoverCommand: CommandHandler<"recover"> = async (cmd, ctx) => {
  const targetSlug = cmd.network ?? ctx.networkSlug;
  const networkId = ctx.requireNetworkId(targetSlug, "recover");
  if (typeof networkId !== "number") return networkId;
  try {
    await pushRecover(networkId);
  } catch (e) {
    // #581 — the recover rejection tokens (nothing_to_recover /
    // already_identified / recovery_in_progress / forbidden) are in the
    // generated channel-error union, so `friendlyError` → `friendlyChannelError`
    // owns the copy. No local bridge needed.
    return { error: friendlyError(e) };
  }
  return { ok: true };
};

/**
 * #247/#356 — `/notify` + `/watch` presence watch (irssi-direct add). POSTs to
 * the per-network REST surface; the server broadcasts the updated notify_list
 * and live-syncs the session's MONITOR/WATCH. The green confirmation names the
 * nicks from the COMMAND input, not the store — the notify_list broadcast that
 * would let us re-render the full list may not have landed by the time the POST
 * resolves, so reading watchByNetwork() here would race. Removal is the
 * settings × (bare /notify opens it). Per-network: the active window's network.
 */
export const notifyCommand: CommandHandler<"notify"> = async (cmd, ctx) => {
  // The id is not used — this arm addresses the network by SLUG over REST — but
  // the network must still exist, so the check is kept and the value
  // deliberately discarded.
  const notifyNet = ctx.requireNetworkId(ctx.networkSlug, "notify");
  if (typeof notifyNet !== "number") return notifyNet;
  await postNotifyAdd(ctx.token, ctx.networkSlug, cmd.nicks);
  return { ok: `notify: watching ${cmd.nicks.join(", ")}` };
};

/**
 * Bundle C (#20 follow-up) — `/oper <name> <password>`. The password travels
 * over the WS frame; the bouncer redacts it from logs by emitting a static log
 * body before sending OPER upstream. The result lands as a 381 RPL_YOUREOPER
 * (success) / 491 (bad host) / 464 (bad pw) numeric, which the numeric-routing
 * path persists as :notice rows.
 *
 * AWAIT the push: a credential-bearing verb MUST NOT silently no-op when the WS
 * is down or the server-side validator rejects
 * (`feedback_no_silent_drops_closed`).
 *
 * #1396 — it lives with the session verbs rather than with the server queries
 * in `server.ts`, whose contract is that none of them changes anything: this
 * one changes the operator's own standing on the network for the rest of the
 * session.
 */
export const operCommand: CommandHandler<"oper"> = async (cmd, ctx) => {
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "oper");
  if (typeof networkId !== "number") return networkId;
  await pushOper(networkId, cmd.name, cmd.password);
  return { ok: true };
};
