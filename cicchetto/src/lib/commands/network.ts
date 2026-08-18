import { patchNetwork } from "../api";
import type { CommandHandler } from "./context";

/**
 * `/connect <network>` — unpark + respawn. Network slug guaranteed by the
 * parser (bare `/connect` surfaces as `kind: "error"` instead).
 */
export const connectCommand: CommandHandler<"connect"> = async (cmd, ctx) => {
  await patchNetwork(ctx.token, cmd.network, { connection_state: "connected" });
  return { ok: true };
};
