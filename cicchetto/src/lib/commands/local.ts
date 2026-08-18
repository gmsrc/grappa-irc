import { addAlias, delAlias } from "../aliasList";
import { requestOpenSettings } from "../settingsNav";
import type { CommandHandler } from "./context";

/**
 * The arms that reach no network: two client-side stores, one UI deep-link,
 * and the parser's own failure arriving as a pseudo-verb. None of them resolves
 * a network id or puts a frame on the wire, which is why none of them reads
 * anything off the context record.
 */

/**
 * #356 — a bare watch-family verb (`/notify`, `/watch`, `/hilight`,
 * `/highlight`, `/dehilight`) opens the unified watch-lists settings section
 * rather than printing inline. Opening the drawer IS the feedback, so this is a
 * silent success.
 */
export const openSettingsCommand: CommandHandler<"open-settings"> = async (cmd) => {
  requestOpenSettings(cmd.section);
  return { ok: true };
};

/**
 * #385 — `/alias <name> <expansion>` defines or overwrites a user alias.
 * Round-tripped through the aliasList store (full-map PUT, server normalizes +
 * validates); a 422 (bad name/expansion, cap exceeded) is thrown as an ApiError
 * and surfaces via `friendlyError` in the dispatcher's catch with the per-field
 * message. The green confirmation echoes the normalized definition.
 */
export const aliasDefineCommand: CommandHandler<"alias-define"> = async (cmd) => {
  await addAlias(cmd.name, cmd.expansion);
  return { ok: `alias: /${cmd.name} → ${cmd.expansion}` };
};

/** #385 — `/unalias <name>` removes a user alias. */
export const unaliasCommand: CommandHandler<"unalias"> = async (cmd) => {
  await delAlias(cmd.name);
  return { ok: `alias: removed /${cmd.name}` };
};

/**
 * A parser-level failure — an unknown verb, or a verb whose arguments did not
 * validate. Not a command: `parseSlash` returns it in the same union so the
 * dispatcher has one shape to route, and the message it carries is the
 * parser's, not this module's.
 */
export const errorCommand: CommandHandler<"error"> = async (cmd) => {
  return { error: cmd.message };
};
