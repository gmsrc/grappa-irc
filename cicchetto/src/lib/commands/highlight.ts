import { addHighlight, delHighlight } from "../highlightList";
import type { CommandHandler } from "./context";

/** `/hilight` + `/dehilight` — the keyword watchlist, add and remove. */
export const watchlistCommand: CommandHandler<"watchlist"> = async (cmd) => {
  const patterns =
    cmd.action === "add" ? await addHighlight(cmd.pattern) : await delHighlight(cmd.pattern);
  return { ok: `highlight (${patterns.length}): ${patterns.join(", ") || "(empty)"}` };
};
