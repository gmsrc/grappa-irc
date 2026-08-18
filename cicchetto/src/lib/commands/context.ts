import type { ChannelKey } from "../channelKey";
import type { SlashCommand } from "../slashCommands";

// #1396 — the dispatch vocabulary, lifted out of `compose.ts` so a command
// handler can live outside the store module. `compose.ts` keeps the store and
// the send pipeline; what moves here is the part that only ever needed a few
// named values.
//
// The record is deliberately NARROW. Of the 87 identifiers the 59-arm switch
// calls, 69 are ordinary module imports a handler can import for itself and 4
// are `compose.ts` top-level consts; only the values below cannot be reached
// that way, because they close over the submitting window. Anything a handler
// can import, it imports — the context carries what is per-submission, not
// what is merely convenient.
export type SubmitResult = { ok: true | string } | { error: string };

// The pump owns the composer buffer and hands the text back on failure, so a
// handler that manages its own residue says so with `keptBuffer`.
export type DispatchOutcome = SubmitResult | { error: string; keptBuffer: true };

export type CommandContext = {
  /** The submitting window. */
  key: ChannelKey;
  networkSlug: string;
  channelName: string;
  /** The raw draft, before parsing — the one arm that re-reads it needs it. */
  text: string;
  /** The session bearer, already proven present by the dispatcher. */
  token: string;
  /**
   * The ACTIVE window's channel, or null when the active window is not a
   * channel. Distinct from `channelName`: a submit can be queued across a
   * window switch, so the two can disagree, and the arms that default a
   * target want the active one.
   */
  getActiveChannel: () => string | null;
};

/**
 * A handler for one verb. Returns what the arm returned: the dispatcher
 * neither inspects nor re-wraps it.
 */
export type CommandHandler<K extends SlashCommand["kind"]> = (
  cmd: Extract<SlashCommand, { kind: K }>,
  ctx: CommandContext,
) => Promise<DispatchOutcome>;
