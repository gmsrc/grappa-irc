import { quitAll } from "../quit";
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
