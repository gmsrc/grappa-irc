import { markLusersRequested } from "../lusersBundle";
import {
  pushAdmin,
  pushInfo,
  pushLinks,
  pushLusers,
  pushMotd,
  pushNames,
  pushRaw,
  pushVersion,
  pushWho,
  pushWhois,
  pushWhowas,
} from "../socket";
import type { CommandHandler } from "./context";

/**
 * The verbs addressed TO the server: the numeric-reply queries and the raw
 * escape hatch. None of them changes anything on this side — each primes a
 * server-side accumulator and the reply burst drains into a modal or a card.
 */

/**
 * #169 — `/who <#chan|nick>`. The server primes who_pending and emits WHO
 * upstream; the 352 burst folds server-side and 315 RPL_ENDOFWHO drains into
 * ONE ephemeral `who_reply` event on the user topic, which WhoModal renders.
 * NOTHING lands in scrollback (mirrors /names).
 *
 * #122 — bare /who defaults to the current channel (shares the requireChannel
 * resolver with /names); it errors only outside one, because the server
 * requires a channel target (RFC 2812 §3.6.1 mask form is out of MVP scope).
 */
export const whoCommand: CommandHandler<"who"> = async (cmd, ctx) => {
  const target = cmd.target ?? ctx.requireChannel("who");
  if (typeof target !== "string") return target;
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "who");
  if (typeof networkId !== "number") return networkId;
  await pushWho(networkId, target); // S6 (#364): await verb-ack
  return { ok: true };
};

/**
 * #140 — `/names [#channel]`. The server buffers the 353/366 burst and emits
 * ONE ephemeral `names_reply` on the user topic; NamesModal renders the
 * grouped, scrollable, dismissable roster. The modal is network-scoped
 * (last-write-wins), so the originating window is irrelevant — no origin
 * passed. #122 — bare /names (and the /n alias) defaults to the current
 * channel, sharing the requireChannel resolver with /who.
 */
export const namesCommand: CommandHandler<"names"> = async (cmd, ctx) => {
  const target = cmd.target ?? ctx.requireChannel("names");
  if (typeof target !== "string") return target;
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "names");
  if (typeof networkId !== "number") return networkId;
  await pushNames(networkId, target); // S6 (#364): await verb-ack
  return { ok: true };
};

/**
 * #238 — `/links [<mask>]`. The server primes links_pending and emits LINKS
 * upstream; the 364 burst folds server-side and 365 RPL_ENDOFLINKS drains ONE
 * ephemeral `links_bundle` event, which LinksModal (mounted in Shell,
 * network-scoped) renders as the interactive topology map. No focus change and
 * no scrollback rows (mirrors /who + /names). An empty bundle (a restricted or
 * oper-only network) still opens the modal, to its "hides topology" state.
 */
export const linksCommand: CommandHandler<"links"> = async (cmd, ctx) => {
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "links");
  if (typeof networkId !== "number") return networkId;
  await pushLinks(networkId, cmd.pattern); // S6 (#364): await verb-ack
  return { ok: true };
};

/**
 * P-0d — `/lusers [<mask> [<server>]]`. The server emits the 7-numeric LUSERS
 * bundle; cic dispatches the typed `:lusers_bundle` wire event in userTopic.ts
 * and renders the LusersCard pinned at the top of the current window (#231).
 * #579 — the mask and target server ride along (they used to be dropped at the
 * parser, so a routed request silently answered from the local server and any
 * mask never reached the wire at all).
 */
export const lusersCommand: CommandHandler<"lusers"> = async (cmd, ctx) => {
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "lusers");
  if (typeof networkId !== "number") return networkId;
  // #248 — mark the request solicited BEFORE pushing so the incoming bundle
  // surfaces the card. The store's gate drops any unsolicited bundle (the
  // Bahamut connect-welcome auto-emit), so an operator /lusers that skipped
  // this mark would show nothing.
  markLusersRequested(ctx.networkSlug);
  await pushLusers(networkId, cmd.mask, cmd.server); // S6 (#364): await verb-ack
  return { ok: true };
};

// #127 — /info, /version, /motd. No-arg server-text queries; the server primes
// the matching accumulator and emits the command, and the reply burst drains a
// typed `server_reply` event that userTopic.ts routes into the
// serverReplyModal store (ServerReplyModal renders it).

export const infoCommand: CommandHandler<"info"> = async (_cmd, ctx) => {
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "info");
  if (typeof networkId !== "number") return networkId;
  await pushInfo(networkId); // S6 (#364): await verb-ack
  return { ok: true };
};

export const versionCommand: CommandHandler<"version"> = async (_cmd, ctx) => {
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "version");
  if (typeof networkId !== "number") return networkId;
  await pushVersion(networkId); // S6 (#364): await verb-ack
  return { ok: true };
};

export const motdCommand: CommandHandler<"motd"> = async (cmd, ctx) => {
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "motd");
  if (typeof networkId !== "number") return networkId;
  // #374 — thread the optional target server through so grappa emits
  // `MOTD <target>` upstream (or bare MOTD when null). A 402 ERR_NOSUCHSERVER
  // for an unknown target surfaces via the same server_reply modal, never a
  // wrong-server MOTD.
  await pushMotd(networkId, cmd.target); // S6 (#364): await verb-ack
  return { ok: true };
};

/**
 * #992 — `/admin [<target>]`. Same door as /motd: bahamut's `m_admin` routes
 * through the same `hunt_server`, so a target sends the query to another
 * server and the reply lands in the same `server_reply` modal under the
 * `admin` source.
 */
export const adminCommand: CommandHandler<"admin"> = async (cmd, ctx) => {
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "admin");
  if (typeof networkId !== "number") return networkId;
  await pushAdmin(networkId, cmd.target); // S6 (#364): await verb-ack
  return { ok: true };
};

/**
 * #155 — `/stats [query] [server]`. Native parser sugar over the #153-de-gated
 * raw transport (mirrors /quote): build the raw STATS frame and ship it via
 * pushRaw. Server routing: the STATS reply family (211-219, 240-250) is
 * server-directed — grappa's numeric_router pins the whole family to the
 * `$server` window as :notice rows via its @active_numerics deny list (#184).
 * Before that fix the terminating 219 RPL_ENDOFSTATS's stats-letter param was
 * mis-read by the scan fallback as a query target, forking a bogus window named
 * after the letter; #155's original "no server change" premise was wrong.
 * AWAIT the push so a WS-disconnected / server {:error,_} surfaces as an inline
 * compose error instead of a silent green ✓ (the #154 no-silent-drop lesson).
 */
export const statsCommand: CommandHandler<"stats"> = async (cmd, ctx) => {
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "stats");
  if (typeof networkId !== "number") return networkId;
  // STATS [query] [server] — omit trailing nulls. IRC STATS is a 2-arg frame;
  // the parser guarantees target is only set when query is, so filtering nulls
  // preserves positional order.
  const line = ["STATS", cmd.query, cmd.target].filter((t): t is string => t !== null).join(" ");
  await pushRaw(networkId, line);
  return { ok: true };
};

/**
 * #155 — `/rehash [option]`. The REHASH/permission numerics (e.g. 481) land on
 * `$server` like the STATS family above. #375: mirror the /stats null filter so
 * the option (MOTD/DNS/GC/…) rides the raw frame instead of being dropped into
 * a bare REHASH.
 */
export const rehashCommand: CommandHandler<"rehash"> = async (cmd, ctx) => {
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "rehash");
  if (typeof networkId !== "number") return networkId;
  const line = ["REHASH", cmd.opt].filter((t): t is string => t !== null).join(" ");
  await pushRaw(networkId, line);
  return { ok: true };
};

/**
 * C2 — `/whois <nick>`. The server primes its accumulator and emits WHOIS
 * upstream; the bundle arrives later as `whois_bundle` on the user topic
 * (userTopic.ts → setWhoisBundle). WHOIS with an explicit nick works from any
 * window kind; the bundle render targets the active window at arrival time.
 *
 * #122 + #132 + #137 — bare /whois (and the /w alias) resolves a context
 * default: a query window gives the partner, every other network-scoped window
 * gives self.
 */
export const whoisCommand: CommandHandler<"whois"> = async (cmd, ctx) => {
  const nick = cmd.nick ?? ctx.resolveBareWhoisNick("whois");
  if (typeof nick !== "string") return nick;
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "whois");
  if (typeof networkId !== "number") return networkId;
  // #198 — cmd.server is set only for the two-arg `/whois <server> <nick>`
  // form; null for single-arg and bare. The bouncer emits `WHOIS <server>
  // <nick>` upstream when present, plain `WHOIS <nick>` otherwise.
  // S6 (#364): await so a validation reject (e.g. invalid_nick, which fires
  // BEFORE the upstream write → no bundle, no numeric) surfaces inline instead
  // of leaving the operator with nothing.
  await pushWhois(networkId, nick, cmd.server);
  return { ok: true };
};

/**
 * P-0c — `/whowas <nick>`. The server primes whowas_pending and emits WHOWAS
 * upstream; the bundle arrives later as `whowas_bundle` on the user topic
 * (userTopic.ts → setWhowasBundle), or as a not_found bundle on 406
 * ERR_WASNOSUCHNICK.
 */
export const whowasCommand: CommandHandler<"whowas"> = async (cmd, ctx) => {
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "whowas");
  if (typeof networkId !== "number") return networkId;
  await pushWhowas(networkId, cmd.nick); // S6 (#364): await verb-ack
  return { ok: true };
};

/**
 * Bundle C (#20 follow-up) — `/quote <raw IRC line>`. Pushed to
 * GrappaChannel.handle_in("raw", _); the server validates CRLF/NUL then ships
 * it verbatim to the upstream socket. AWAIT the push so disconnected/error
 * replies surface as inline compose-box alerts (no silent green ✓ on a dropped
 * escape-hatch frame).
 */
export const quoteCommand: CommandHandler<"quote"> = async (cmd, ctx) => {
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "quote");
  if (typeof networkId !== "number") return networkId;
  await pushRaw(networkId, cmd.line);
  return { ok: true };
};
