import { postTopic } from "../api";
import { pushChannelTopicClear } from "../socket";
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

/**
 * `/topic <text>` or `/topic #chan <text>` — set the topic via REST. An
 * explicit channel wins; otherwise the current channel; otherwise bail.
 */
export const topicSetCommand: CommandHandler<"topic-set"> = async (cmd, ctx) => {
  const ch = cmd.channel ?? ctx.getActiveChannel();
  if (!ch)
    return {
      error: "/topic requires a channel — switch to one or use /topic #chan <text>",
    };
  await postTopic(ctx.token, ctx.networkSlug, ch, cmd.text);
  return { ok: true };
};

/** `/topic -delete` or `/topic #chan -delete` — clear the topic via channel event. */
export const topicClearCommand: CommandHandler<"topic-clear"> = async (cmd, ctx) => {
  const ch = cmd.channel ?? ctx.getActiveChannel();
  if (!ch)
    return {
      error: "/topic -delete requires a channel — switch to one or use /topic #chan -delete",
    };
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "topic -delete");
  if (typeof networkId !== "number") return networkId;
  // S21: AWAIT the verb ack (#154 no-silent-drops). A WS-down / server
  // {:error,_} rejects into the dispatcher's shared catch → friendlyChannelError
  // inline alert, instead of painting a green ✓ on a dropped frame.
  await pushChannelTopicClear(networkId, ch);
  return { ok: true };
};
