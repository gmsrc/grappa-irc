import { sendBodyLines } from "../sendPipeline";
import { openServiceModal } from "../serviceModal";
import type { CommandHandler } from "./context";

/**
 * #290 — a BARE services command (`/ns`, `/cs`, `/ms`, …) opens the dedicated
 * services console modal and fires `help`, so the service's multi-NOTICE help
 * wall lands confined in the modal (ServiceModal mirrors the $server service
 * notices) instead of flooding the server window. `openServiceModal` FIRST
 * captures the $server high-water mark, THEN `help` is sent, so the reply
 * notices count as while-open arrivals (spec: capture only while open). A full
 * command WITH args stays the `msg` arm (inline execute, reply inline) — no
 * unsolicited popup for power users.
 *
 * #1396 — it could only move here once #1513 lifted `sendBodyLines` out of the
 * store closure: that import was its whole blocker, and it is the ONLY arm the
 * hoist unblocked. It reads `ctx.networkSlug` and nothing else off the record —
 * both the modal and the send address the SUBMITTING window's network, never
 * the selected one.
 */
export const serviceModalCommand: CommandHandler<"service-modal"> = async (cmd, ctx) => {
  openServiceModal(ctx.networkSlug, cmd.service);
  await sendBodyLines(ctx.networkSlug, cmd.service, "help", false);
  return { ok: true };
};
