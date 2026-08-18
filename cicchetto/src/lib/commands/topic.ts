import type { CommandHandler } from "./context";

/**
 * Bare `/topic` or `/topic #chan` — render the cached topic inline. The
 * cached topic lives in `channelTopic.ts`; rendering is pure UI.
 *
 * TODO(C3): wire to TopicBar's cached topic for inline render.
 */
export const topicShowCommand: CommandHandler<"topic-show"> = async (cmd, ctx) => {
  const ch = cmd.channel ?? ctx.getActiveChannel();
  if (!ch) return { error: "/topic requires a channel — switch to one or use /topic #chan" };
  return { error: `/topic ${ch} (bare) — inline render wired in C3 (TopicBar)` };
};
